import { describe, expect, it } from "vitest";
import type { OverviewModule, OverviewOutlineItem, WorkspaceFileTree } from "../../../lib/adapter";
import {
  buildExplorerTree,
  buildVisibleExplorerRows,
  canDropExplorerRow,
  collectAncestorExpandedIds,
  defaultCreatePath,
  explorerKindBadge,
  findSelectedRowId,
  parentPathFor,
  setsMatch,
} from "./treeModel";
import type { ExplorerDragState } from "./types";

function outline(
  moduleName: string,
  label: string,
  kind: OverviewOutlineItem["kind"] = "function",
): OverviewOutlineItem {
  return {
    id: `outline:symbol:${moduleName}:${label}`,
    nodeId: `symbol:${moduleName}:${label}`,
    label,
    kind,
    startLine: 1,
    topLevel: true,
  };
}

function moduleFixture(
  moduleName: string,
  relativePath: string,
  outlineItems: OverviewOutlineItem[] = [],
): OverviewModule {
  return {
    id: `module-row:${moduleName}`,
    moduleId: `module:${moduleName}`,
    moduleName,
    relativePath,
    symbolCount: outlineItems.length,
    importCount: 0,
    callCount: 0,
    outline: outlineItems,
  };
}

function workspaceTree(): WorkspaceFileTree {
  return {
    rootPath: "C:/repo",
    truncated: false,
    entries: [
      directory("docs"),
      file("docs/guide.md"),
      file("notes.txt"),
      file("pyproject.toml"),
      directory("src"),
      directory("src/helm"),
      file("src/helm/cli.py"),
      directory("src/helm/ui"),
      file("src/helm/ui/api.py"),
    ],
  };
}

function directory(relativePath: string) {
  return {
    relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
    kind: "directory" as const,
    sizeBytes: null,
    editable: false,
    reason: "Directories are shown in the explorer.",
    modifiedAt: 0,
  };
}

function file(relativePath: string) {
  return {
    relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
    kind: "file" as const,
    sizeBytes: 10,
    editable: true,
    reason: null,
    modifiedAt: 0,
  };
}

const modules = [
  moduleFixture("helm.cli", "src/helm/cli.py", [outline("helm.cli", "main")]),
  moduleFixture("helm.generated", "src/helm/generated.py", [
    outline("helm.generated", "build_generated"),
  ]),
  moduleFixture("helm.ui.api", "src/helm/ui/api.py", [
    outline("helm.ui.api", "GraphSummary", "class"),
    outline("helm.ui.api", "build_graph_summary"),
  ]),
];

describe("treeModel", () => {
  it("merges workspace files and indexed modules into a deterministic tree", () => {
    const tree = buildExplorerTree(modules, workspaceTree());

    expect(tree.rootIds.map((id) => tree.nodesById.get(id)?.label)).toEqual([
      "docs",
      "src",
      "notes.txt",
      "pyproject.toml",
    ]);

    const api = tree.nodesById.get("file:src/helm/ui/api.py");
    expect(api?.workspaceEntry?.relativePath).toBe("src/helm/ui/api.py");
    expect(api?.module?.moduleName).toBe("helm.ui.api");
    expect(api?.childIds.map((id) => tree.nodesById.get(id)?.label)).toEqual([
      "build_graph_summary",
      "GraphSummary",
    ]);

    const generated = tree.nodesById.get("file:src/helm/generated.py");
    expect(generated?.workspaceEntry).toBeUndefined();
    expect(generated?.module?.moduleName).toBe("helm.generated");
  });

  it("honors expansion state when deriving visible rows", () => {
    const tree = buildExplorerTree(modules, workspaceTree());

    expect(buildVisibleExplorerRows(tree, new Set()).map((row) => row.id)).toEqual([
      "dir:docs",
      "dir:src",
      "file:notes.txt",
      "file:pyproject.toml",
    ]);

    const rows = buildVisibleExplorerRows(
      tree,
      new Set(["dir:src", "dir:src/helm", "dir:src/helm/ui", "file:src/helm/ui/api.py"]),
    );

    expect(rows.map((row) => row.id)).toContain("file:src/helm/ui/api.py");
    expect(rows.map((row) => row.id)).toContain(
      "outline:src/helm/ui/api.py:symbol:helm.ui.api:build_graph_summary",
    );
    expect(rows.map((row) => row.id)).not.toContain("file:docs/guide.md");
  });

  it("resolves selected rows and expandable ancestors", () => {
    const tree = buildExplorerTree(modules, workspaceTree());
    const symbolRowId = "outline:src/helm/ui/api.py:symbol:helm.ui.api:build_graph_summary";

    expect(findSelectedRowId(tree, undefined, "symbol:helm.ui.api:build_graph_summary")).toBe(
      symbolRowId,
    );
    expect(findSelectedRowId(tree, undefined, "module:helm.ui.api")).toBe(
      "file:src/helm/ui/api.py",
    );
    expect(findSelectedRowId(tree, "docs/guide.md")).toBe("file:docs/guide.md");
    expect(collectAncestorExpandedIds(tree, symbolRowId)).toEqual([
      "dir:src",
      "dir:src/helm",
      "dir:src/helm/ui",
      "file:src/helm/ui/api.py",
    ]);
  });

  it("keeps badge, path, set, and drop guard helpers stable", () => {
    const tree = buildExplorerTree(modules, workspaceTree());
    const docs = tree.nodesById.get("dir:docs")!;
    const src = tree.nodesById.get("dir:src")!;
    const srcHelm = tree.nodesById.get("dir:src/helm")!;
    const notesDrag: ExplorerDragState = {
      rowId: "file:notes.txt",
      kind: "file",
      path: "notes.txt",
    };

    expect(explorerKindBadge(docs)).toBe("dir");
    expect(explorerKindBadge(tree.nodesById.get("file:src/helm/ui/api.py")!)).toBe("file");
    expect(
      explorerKindBadge(
        tree.nodesById.get("outline:src/helm/ui/api.py:symbol:helm.ui.api:GraphSummary")!,
      ),
    ).toBe("class");
    expect(defaultCreatePath("file", "docs")).toBe("docs/untitled.txt");
    expect(defaultCreatePath("directory")).toBe("new-folder");
    expect(parentPathFor("src/helm/cli.py")).toBe("src/helm");
    expect(setsMatch(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);

    expect(canDropExplorerRow(null, docs)).toBe(false);
    expect(canDropExplorerRow(notesDrag, docs)).toBe(true);
    expect(canDropExplorerRow({ ...notesDrag, path: "docs/guide.md" }, docs)).toBe(false);
    expect(canDropExplorerRow({ rowId: src.id, kind: "directory", path: "src" }, src)).toBe(false);
    expect(canDropExplorerRow({ rowId: src.id, kind: "directory", path: "src" }, srcHelm)).toBe(
      false,
    );
  });
});
