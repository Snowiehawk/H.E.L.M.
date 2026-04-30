import type { OverviewModule, OverviewOutlineItem, WorkspaceFileTree } from "../../../lib/adapter";
import type { ExplorerDragState, ExplorerTreeData, ExplorerTreeNode } from "./types";

export function compareExplorerNodes(left: ExplorerTreeNode, right: ExplorerTreeNode): number {
  if (left.kind !== right.kind) {
    if (left.kind === "directory") {
      return -1;
    }
    if (right.kind === "directory") {
      return 1;
    }
  }

  return left.label.localeCompare(right.label);
}

export function buildExplorerTree(
  modules: OverviewModule[],
  workspaceFiles?: WorkspaceFileTree,
): ExplorerTreeData {
  const nodesById = new Map<string, ExplorerTreeNode>();
  const rootIds: string[] = [];
  const modulesByRelativePath = new Map(modules.map((module) => [module.relativePath, module]));

  const appendChild = (parentId: string | undefined, childId: string) => {
    if (parentId) {
      const parent = nodesById.get(parentId);
      if (parent && !parent.childIds.includes(childId)) {
        parent.childIds.push(childId);
      }
      return;
    }

    if (!rootIds.includes(childId)) {
      rootIds.push(childId);
    }
  };

  const ensureDirectory = (parts: string[]) => {
    let parentId: string | undefined;

    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      const directoryId = `dir:${path}`;

      if (!nodesById.has(directoryId)) {
        const entry = workspaceFiles?.entries.find(
          (candidate) => candidate.kind === "directory" && candidate.relativePath === path,
        );
        nodesById.set(directoryId, {
          id: directoryId,
          label: part,
          path,
          depth: index,
          kind: "directory",
          parentId,
          childIds: [],
          workspaceEntry: entry,
        });
        appendChild(parentId, directoryId);
      }

      parentId = directoryId;
    });

    return parentId;
  };

  const addFile = (
    relativePath: string,
    workspaceEntry?: WorkspaceFileTree["entries"][number],
    module?: OverviewModule,
  ) => {
    const parts = relativePath.split("/").filter(Boolean);
    const parentId = ensureDirectory(parts.slice(0, -1));
    const fileId = `file:${relativePath}`;
    const fileNode = nodesById.get(fileId);
    const nextNode: ExplorerTreeNode = {
      id: fileId,
      label: parts[parts.length - 1] ?? relativePath,
      path: relativePath,
      depth: Math.max(parts.length - 1, 0),
      kind: "file",
      parentId,
      childIds: fileNode?.childIds ?? [],
      workspaceEntry,
      module,
    };
    nodesById.set(fileId, nextNode);
    appendChild(parentId, fileId);

    const outline = module?.outline ?? [];
    outline.forEach((outlineItem) => {
      const outlineId = `outline:${relativePath}:${outlineItem.nodeId}`;
      nodesById.set(outlineId, {
        id: outlineId,
        label: outlineItem.label,
        path: relativePath,
        depth: Math.max(parts.length, 0),
        kind: "outline",
        parentId: fileId,
        childIds: [],
        workspaceEntry,
        module,
        outlineItem,
      });
      appendChild(fileId, outlineId);
    });
  };

  [...(workspaceFiles?.entries ?? [])]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .forEach((entry) => {
      const parts = entry.relativePath.split("/").filter(Boolean);
      if (entry.kind === "directory") {
        ensureDirectory(parts);
        return;
      }

      addFile(entry.relativePath, entry, modulesByRelativePath.get(entry.relativePath));
    });

  [...modules]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .forEach((module) => {
      if (nodesById.has(`file:${module.relativePath}`)) {
        return;
      }
      addFile(module.relativePath, undefined, module);
    });

  nodesById.forEach((node) => {
    if (node.kind !== "directory" && node.kind !== "file") {
      return;
    }

    node.childIds.sort((leftId, rightId) =>
      compareExplorerNodes(nodesById.get(leftId)!, nodesById.get(rightId)!),
    );
  });

  rootIds.sort((leftId, rightId) =>
    compareExplorerNodes(nodesById.get(leftId)!, nodesById.get(rightId)!),
  );

  return {
    nodesById,
    rootIds,
  };
}

export function buildVisibleExplorerRows(
  tree: ExplorerTreeData,
  expandedIds: Set<string>,
): ExplorerTreeNode[] {
  const rows: ExplorerTreeNode[] = [];

  const visit = (nodeId: string) => {
    const node = tree.nodesById.get(nodeId);
    if (!node) {
      return;
    }

    rows.push(node);

    if (isExpandableNode(node) && expandedIds.has(node.id)) {
      node.childIds.forEach(visit);
    }
  };

  tree.rootIds.forEach(visit);
  return rows;
}

export function isExpandableNode(row: ExplorerTreeNode): boolean {
  return row.childIds.length > 0 && (row.kind === "directory" || row.kind === "file");
}

export function isSelectedRow(
  row: ExplorerTreeNode,
  selectedFilePath?: string,
  selectedNodeId?: string,
): boolean {
  if (row.kind === "outline") {
    return selectedNodeId === row.outlineItem?.nodeId;
  }

  return (
    row.kind === "file" &&
    (selectedFilePath === row.path || Boolean(row.module && selectedNodeId === row.module.moduleId))
  );
}

export function findSelectedRowId(
  tree: ExplorerTreeData,
  selectedFilePath?: string,
  selectedNodeId?: string,
): string | null {
  if (selectedNodeId) {
    for (const node of tree.nodesById.values()) {
      if (node.kind === "outline" && node.outlineItem?.nodeId === selectedNodeId) {
        return node.id;
      }
    }

    for (const node of tree.nodesById.values()) {
      if (node.kind === "file" && node.module?.moduleId === selectedNodeId) {
        return node.id;
      }
    }
  }

  if (selectedFilePath) {
    for (const node of tree.nodesById.values()) {
      if (node.kind === "file" && node.path === selectedFilePath) {
        return node.id;
      }
    }
  }

  return null;
}

export function collectAncestorExpandedIds(tree: ExplorerTreeData, rowId: string | null): string[] {
  const ancestorIds: string[] = [];
  let currentId = rowId ? tree.nodesById.get(rowId)?.parentId : undefined;

  while (currentId) {
    ancestorIds.unshift(currentId);
    currentId = tree.nodesById.get(currentId)?.parentId;
  }

  return ancestorIds.filter((ancestorId) => {
    const ancestor = tree.nodesById.get(ancestorId);
    return ancestor ? isExpandableNode(ancestor) : false;
  });
}

export function setsMatch(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

export function outlineKindBadge(kind: OverviewOutlineItem["kind"]): string {
  switch (kind) {
    case "async_function":
      return "async";
    case "class":
      return "class";
    case "enum":
      return "enum";
    case "variable":
      return "var";
    default:
      return "fn";
  }
}

export function explorerKindBadge(row: ExplorerTreeNode): string | null {
  switch (row.kind) {
    case "directory":
      return "dir";
    case "file":
      return "file";
    case "outline":
      return row.outlineItem ? outlineKindBadge(row.outlineItem.kind) : null;
    default:
      return null;
  }
}

export function defaultCreatePath(kind: "file" | "directory", parentPath?: string) {
  const prefix = parentPath ? `${parentPath.replace(/\/+$/, "")}/` : "";
  return kind === "file" ? `${prefix}untitled.txt` : `${prefix}new-folder`;
}

export function parentPathFor(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

export function canDropExplorerRow(
  source: ExplorerDragState | null,
  target: ExplorerTreeNode,
): source is ExplorerDragState {
  if (!source || target.kind !== "directory") {
    return false;
  }
  if (source.path === target.path || parentPathFor(source.path) === target.path) {
    return false;
  }
  if (source.kind === "directory" && target.path.startsWith(`${source.path}/`)) {
    return false;
  }
  return true;
}
