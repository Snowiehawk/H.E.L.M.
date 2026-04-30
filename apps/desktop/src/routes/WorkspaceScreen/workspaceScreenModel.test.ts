import { describe, expect, it } from "vitest";
import type { FlowGraphDocument } from "../../lib/adapter";
import {
  buildFallbackGraphPathItems,
  clampExplorerSidebarWidth,
  graphNodeSourceRange,
  graphRevealPath,
  isShortcutBypassTarget,
  isTextEditingTarget,
  readStoredExplorerSidebarWidth,
  synchronizeFlowLayoutWithDocumentMutation,
  workspaceRecursivePreviewMessage,
} from "./workspaceScreenModel";

function flowDocument(nodes: FlowGraphDocument["nodes"], edges: FlowGraphDocument["edges"] = []) {
  return {
    symbolId: "symbol:pkg.mod:run",
    relativePath: "pkg/mod.py",
    qualname: "run",
    nodes,
    edges,
    syncState: "clean",
    diagnostics: [],
    editable: true,
  } satisfies FlowGraphDocument;
}

describe("workspaceScreenModel", () => {
  it("builds graph reveal paths from Python module paths", () => {
    expect(graphRevealPath("pkg/mod.py")).toBe("pkg/mod.py");
    expect(graphRevealPath("pkg")).toBe("pkg");
    expect(graphRevealPath(undefined)).toBeUndefined();
  });

  it("derives source range metadata", () => {
    expect(
      graphNodeSourceRange({
        id: "node",
        kind: "function",
        label: "run",
        x: 0,
        y: 0,
        metadata: {
          source_start_line: 3,
          source_end_line: 8,
          source_start_column: 2,
          source_end_column: 12,
        },
        availableActions: [],
      }),
    ).toEqual({
      startLine: 3,
      endLine: 8,
      startColumn: 2,
      endColumn: 12,
    });
  });

  it("classifies shortcut bypass targets", () => {
    document.body.innerHTML =
      '<button><span id="icon"></span></button><textarea id="editor"></textarea>';
    expect(isShortcutBypassTarget(document.getElementById("icon"))).toBe(true);
    expect(isTextEditingTarget(document.getElementById("editor"))).toBe(true);
  });

  it("keeps stored sidebar widths inside bounds", () => {
    window.localStorage.setItem("helm.blueprint.explorerSidebarWidth", "9999");
    expect(clampExplorerSidebarWidth(readStoredExplorerSidebarWidth(), 800)).toBe(430);
  });

  it("summarizes recursive workspace previews", () => {
    expect(
      workspaceRecursivePreviewMessage({
        operationKind: "delete",
        sourceRelativePath: "pkg",
        entryKind: "directory",
        counts: {
          entryCount: 3,
          fileCount: 2,
          directoryCount: 1,
          symlinkCount: 0,
          totalSizeBytes: 2048,
          pythonFileCount: 1,
        },
        warnings: ["Large folder"],
        impactFingerprint: "fp",
        affectedPaths: ["pkg/a.py", "pkg/b.txt"],
        affectedPathsTruncated: false,
      }),
    ).toContain("Entries: 3 (2 files, 1 folders)");
  });

  it("synchronizes flow layout after document mutation", () => {
    const currentDocument = flowDocument(
      [
        { id: "entry", kind: "entry", payload: {} },
        { id: "old", kind: "assign", payload: {} },
      ],
      [
        {
          id: "edge-old",
          sourceId: "entry",
          sourceHandle: "out",
          targetId: "old",
          targetHandle: "in",
        },
      ],
    );
    const nextDocument = flowDocument([{ id: "entry", kind: "entry", payload: {} }]);

    const nextLayout = synchronizeFlowLayoutWithDocumentMutation({
      currentDocument,
      nextDocument,
      layout: {
        nodes: {
          entry: { x: 1, y: 2 },
          old: { x: 3, y: 4 },
        },
        reroutes: [{ id: "reroute", edgeId: "edge-old", order: 0, x: 0, y: 0 }],
        pinnedNodeIds: ["entry", "old"],
        groups: [{ id: "group", title: "Group", memberNodeIds: ["entry", "old"] }],
      },
      seededNodes: [{ nodeId: "new", kind: "assign", position: { x: 9, y: 10 } }],
    });

    expect(nextLayout.nodes).toEqual({
      entry: { x: 1, y: 2 },
      new: { x: 9, y: 10 },
    });
    expect(nextLayout.reroutes).toEqual([]);
    expect(nextLayout.pinnedNodeIds).toEqual(["entry"]);
    expect(nextLayout.groups).toEqual([]);
  });

  it("builds fallback graph path items for symbol flow routes", () => {
    expect(
      buildFallbackGraphPathItems(
        { id: "repo", name: "Repo", path: "C:/repo" },
        "symbol:pkg.mod:run",
        "flow",
        [
          {
            id: "module:pkg.mod",
            moduleId: "module:pkg.mod",
            moduleName: "pkg.mod",
            relativePath: "pkg/mod.py",
            symbolCount: 1,
            importCount: 0,
            callCount: 0,
          },
        ],
      ).map((item) => item.label),
    ).toEqual(["Repo", "pkg", "mod.py", "run", "Flow"]);
  });
});
