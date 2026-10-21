import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ExecutionSnapshot } from "./adapter";
import type { ExecutionContext } from "./contracts";
import { DiagnosticStream, type RunDiagnostic } from "./diagnostics";
import { parseOutputLinks } from "./links";
import { navigateRunDiagnostic, type ValidatedDiagnosticLocation } from "./navigation";
import { outputText } from "./output";
import type { PreparedSource } from "./preparation";

export interface RunOutputNavigationProps {
  snapshot: ExecutionSnapshot;
  context: ExecutionContext;
  cwd: string;
  preparedSource: PreparedSource;
  /** Recheck live renderer consent immediately before a native browser request. */
  canActivateBrowser(): boolean;
  onError(error: unknown): void;
}

/** Each instance is bound to the captured run context, never the current config. */
export function RunOutputNavigation({
  snapshot,
  context,
  cwd,
  preparedSource,
  canActivateBrowser,
  onError,
}: RunOutputNavigationProps) {
  const [pending, setPending] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const activeClick = useRef(0);
  const clickBusy = useRef(false);
  const clickAbort = useRef<AbortController>();
  const currentRun = useRef(snapshot.id);
  if (currentRun.current !== snapshot.id) {
    currentRun.current = snapshot.id;
    activeClick.current += 1;
  }
  useEffect(() => {
    // A retired click must not disable navigation in replacement output.
    clickBusy.current = false;
    setPending(undefined);
    setNotice(undefined);
    return () => {
      activeClick.current += 1;
      clickAbort.current?.abort();
    };
  }, [snapshot.id, context.contextId]);
  const diagnostics = useMemo(() => {
    const parser = new DiagnosticStream(snapshot.id);
    // Reconstruct each retained stream independently, preserving multibyte reads.
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const atLineBoundary = { stdout: !snapshot.truncated, stderr: !snapshot.truncated };
    for (const chunk of snapshot.chunks) {
      if (chunk.stream !== "terminal") {
        let text = decoders[chunk.stream].decode(new Uint8Array(chunk.data), { stream: true });
        if (!atLineBoundary[chunk.stream]) {
          const newline = text.indexOf("\n");
          if (newline < 0) continue;
          atLineBoundary[chunk.stream] = true;
          text = text.slice(newline + 1);
        }
        parser.push(text, chunk.stream);
      }
    }
    for (const stream of ["stdout", "stderr"] as const) {
      parser.push(decoders[stream].decode(), stream);
      if (snapshot.outputComplete) parser.finish(stream);
    }
    return parser.diagnostics;
  }, [snapshot]);
  const text = useMemo(() => outputText(snapshot), [snapshot]);
  const links = useMemo(() => parseOutputLinks(text), [text]);
  const reveal = async (diagnostic: RunDiagnostic) => {
    if (clickBusy.current) return;
    clickBusy.current = true;
    const abort = new AbortController();
    clickAbort.current = abort;
    const request = ++activeClick.current;
    setPending(diagnostic.id);
    setNotice(undefined);
    try {
      const resolve = (expectedHash?: string) =>
        invoke<ValidatedDiagnosticLocation>("execution_resolve_diagnostic", {
          context,
          cwd,
          path: diagnostic.path,
          line: diagnostic.line,
          column: diagnostic.column,
          expectedHash,
        });
      let location = await resolve();
      if (request !== activeClick.current || currentRun.current !== snapshot.id) return;
      const prepared = preparedSource.files.find(
        (file) => file.relativePath === location.relativePath,
      );
      if (prepared) location = await resolve(prepared.sha256);
      if (request !== activeClick.current || currentRun.current !== snapshot.id) return;
      const mapping = await navigateRunDiagnostic({
        context,
        location,
        preparedSource,
        signal: abort.signal,
      });
      if (request === activeClick.current) setNotice(mapping.reason);
    } catch (error) {
      if (request === activeClick.current) onError(error);
    } finally {
      if (request === activeClick.current) {
        clickBusy.current = false;
        setPending(undefined);
      }
    }
  };
  const openLink = async (url: string) => {
    if (clickBusy.current) return;
    clickBusy.current = true;
    const request = ++activeClick.current;
    setPending(url);
    setNotice(undefined);
    try {
      // The captured run context alone does not include a synchronous local
      // revocation that is still waiting for native cleanup acknowledgment.
      if (!canActivateBrowser?.())
        throw new Error(
          "Execution consent changed. Trust this project explicitly before opening a run link.",
        );
      await invoke("execution_open_loopback", { context, url });
    } catch (error) {
      if (request === activeClick.current) onError(error);
    } finally {
      if (request === activeClick.current) {
        clickBusy.current = false;
        setPending(undefined);
      }
    }
  };
  return (
    <div className="execution-output-navigation">
      {snapshot.outputComplete && diagnostics.length === 0 && text.trim().length > 0 && (
        <p role="status">
          Source navigation is unavailable: no supported file location was recognized.
        </p>
      )}
      {diagnostics.length > 0 && (
        <div aria-label="Run diagnostic locations">
          <strong>Source locations</strong>
          <ul>
            {diagnostics.map((diagnostic) => (
              <li key={diagnostic.id}>
                <button
                  disabled={Boolean(pending)}
                  title={diagnostic.text}
                  onClick={() => {
                    void reveal(diagnostic);
                  }}
                >
                  {diagnostic.path}:{diagnostic.line}:{diagnostic.column}
                  {diagnostic.repetitions > 1 ? ` (${diagnostic.repetitions})` : ""}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {links.length > 0 && (
        <div aria-label="Output links">
          <strong>Links</strong>
          <ul>
            {links.map((link, index) => (
              <li key={`${link.target}:${index}`}>
                <button
                  disabled={!link.allowed || Boolean(pending)}
                  title={link.reason ?? `Open ${link.target} in the system browser`}
                  onClick={() => {
                    void openLink(link.target);
                  }}
                >
                  {link.target}
                </button>
                {link.label !== link.target && <span> · label: {link.label}</span>}
                {!link.allowed && <span> · {link.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {pending && <p role="status">Opening validated location…</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
