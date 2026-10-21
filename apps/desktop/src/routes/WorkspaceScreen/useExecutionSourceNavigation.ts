import { useEffect, useRef } from "react";
import type {
  DesktopAdapter,
  GraphFilters,
  GraphSettings,
  RepoSession,
  WorkspaceFileContents,
} from "../../lib/adapter";
import {
  registerExecutionNavigation,
  type ValidatedDiagnosticLocation,
} from "../../execution/navigation";
import {
  resolveGraphDiagnostic,
  resolvePreparedGraphDiagnostic,
  type DiagnosticGraphMapping,
} from "../../execution/mapping";
import { readWorkspacePreparationSnapshot } from "../../execution/preparation";

interface NavigationOptions {
  session?: RepoSession;
  adapter: DesktopAdapter;
  graphFilters: GraphFilters;
  graphSettings: GraphSettings;
  hasUnsavedDrafts(): boolean;
  openFile(location: ValidatedDiagnosticLocation, file: WorkspaceFileContents): void;
  focusSymbol(nodeId: string): void;
}

/** Kept in the IDE: neither Issues nor output views can bypass draft ownership. */
export function useExecutionSourceNavigation(options: NavigationOptions) {
  const state = useRef(options);
  state.current = options;
  useEffect(
    () =>
      registerExecutionNavigation(async (request) => {
        const original = state.current;
        const initial = readWorkspacePreparationSnapshot();
        const ensureCurrent = () => {
          if (request.signal?.aborted) throw new Error("Diagnostic navigation canceled.");
          const current = state.current;
          const now = readWorkspacePreparationSnapshot();
          if (
            !initial ||
            !now ||
            !current.session ||
            current.session.id !== request.context.generation ||
            current.session.id !== original.session?.id ||
            current.session.path !== original.session?.path ||
            now.repoPath !== initial.repoPath ||
            now.sessionId !== initial.sessionId ||
            now.revision !== initial.revision
          )
            throw new Error(
              "The workspace or its edits changed during diagnostic navigation. Retry from the current IDE.",
            );
          if (current.hasUnsavedDrafts() || now.blockers.length || now.saves.length)
            throw new Error(
              "Finish or save the current editor drafts before diagnostic navigation. Every draft has been preserved.",
            );
        };
        ensureCurrent();
        const location = request.location;
        const file = await original.adapter.readWorkspaceFile(
          original.session!.path,
          location.relativePath,
        );
        ensureCurrent();
        const bytes = new TextEncoder().encode(file.content);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const currentHash = Array.from(new Uint8Array(digest), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join("");
        if (currentHash !== location.currentHash)
          throw new Error("The diagnostic file changed during navigation. Retry the location.");
        const source = request.preparedSource.files.find(
          (item) => item.relativePath === location.relativePath,
        );
        const base = {
          relativePath: location.relativePath,
          line: location.line,
          column: location.column,
          sourceLineText: location.lineText ?? undefined,
          runSourceHash: source?.sha256,
          currentSourceHash: currentHash,
        };
        let mapping: DiagnosticGraphMapping = {
          status: "unmapped",
          reason: "The file location is available; no source-proven graph node is available.",
        };
        if (source && source.sha256 !== currentHash)
          mapping = {
            status: "stale",
            reason:
              "This file changed since the run. The current file is open without selecting an old line or graph node.",
          };
        else if (source) {
          // These frozen parser facts propose a lookup only. Current graph metadata
          // must independently agree before focus/selection is permitted.
          const proofs = request.preparedSource.indexedSymbols.filter(
            (proof) =>
              proof.relativePath === location.relativePath && proof.sourceHash === currentHash,
          );
          const candidate = resolveGraphDiagnostic({
            ...base,
            indexedSourceHash: currentHash,
            nodes: proofs.map((proof) => ({
              id: proof.nodeId,
              kind: "symbol",
              label: "",
              x: 0,
              y: 0,
              availableActions: [],
              metadata: {
                relative_path: proof.relativePath,
                source_start_line: proof.startLine,
                source_start_column: proof.startColumn,
                source_end_line: proof.endLine,
                source_end_column: proof.endColumn,
              },
            })),
          });
          mapping = candidate;
          if (candidate.status === "symbol" || candidate.status === "exact") {
            try {
              const graph = await original.adapter.getGraphView(
                candidate.nodeId,
                "symbol",
                original.graphFilters,
                original.graphSettings,
              );
              mapping = resolvePreparedGraphDiagnostic({
                ...base,
                nodes: graph.nodes,
                indexedSymbols: proofs,
              });
            } catch {
              mapping = {
                status: "unmapped",
                reason:
                  "The current graph is unavailable. The validated file location remains usable.",
              };
            }
          }
        }
        // A graph lookup may wait on the bridge while another application writes
        // this file. Watcher delivery is not authoritative source-version proof.
        const finalFile = await original.adapter.readWorkspaceFile(
          original.session!.path,
          location.relativePath,
        );
        ensureCurrent();
        const finalDigest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(finalFile.content),
        );
        const finalHash = Array.from(new Uint8Array(finalDigest), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join("");
        if (finalHash !== location.currentHash || finalFile.version !== file.version)
          throw new Error(
            "The diagnostic file changed while loading its graph. Retry the location.",
          );
        ensureCurrent();
        // No async gap after the final ownership/draft check.
        state.current.openFile(location, finalFile);
        if (mapping.status === "symbol" || mapping.status === "exact")
          state.current.focusSymbol(mapping.nodeId);
        return mapping;
      }),
    [],
  );
}
