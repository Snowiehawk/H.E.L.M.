import { copyToClipboard, systemFileExplorerLabel } from "../../shared/AppContextMenu";
import { isExpandableNode } from "./treeModel";
import type { ExplorerContextMenuItem, ExplorerTreeNode } from "./types";

export function joinRepoPath(repoPath: string | undefined, relativePath: string) {
  if (!repoPath) {
    return relativePath;
  }

  const normalizedRepoPath = repoPath.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedRelativePath = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  return `${normalizedRepoPath}/${normalizedRelativePath}`;
}

export function buildExplorerContextMenuItems({
  expandedIds,
  onDeleteWorkspaceRow,
  onOpenPathInDefaultEditor,
  onRevealPathInFileExplorer,
  onSelectModule,
  onSelectSymbol,
  onSelectWorkspaceFile,
  onStartCreateWorkspaceEntry,
  onToggleExpansion,
  repoPath,
  row,
}: {
  expandedIds: Set<string>;
  onDeleteWorkspaceRow: (row: ExplorerTreeNode) => void | Promise<void>;
  onOpenPathInDefaultEditor: (relativePath: string) => void | Promise<void>;
  onRevealPathInFileExplorer: (relativePath: string) => void | Promise<void>;
  onSelectModule: (module: NonNullable<ExplorerTreeNode["module"]>) => void;
  onSelectSymbol: (nodeId: string) => void;
  onSelectWorkspaceFile: (relativePath: string) => void;
  onStartCreateWorkspaceEntry: (kind: "file" | "directory", parentPath?: string) => void;
  onToggleExpansion: (rowId: string) => void;
  repoPath?: string;
  row: ExplorerTreeNode;
}): ExplorerContextMenuItem[] {
  const absolutePath = joinRepoPath(repoPath, row.path);
  const revealLabel = systemFileExplorerLabel();
  const items: ExplorerContextMenuItem[] = [];

  if (row.kind === "directory") {
    items.push({
      id: "toggle-folder",
      label: expandedIds.has(row.id) ? "Collapse Folder" : "Expand Folder",
      action: () => onToggleExpansion(row.id),
    });
    items.push(
      {
        id: "new-file",
        label: "New File",
        action: () => onStartCreateWorkspaceEntry("file", row.path),
      },
      {
        id: "new-folder",
        label: "New Folder",
        action: () => onStartCreateWorkspaceEntry("directory", row.path),
      },
    );
  }

  if (row.kind === "file") {
    items.push({
      id: "open-file",
      label: "Open in H.E.L.M.",
      action: () => {
        if (row.module) {
          onSelectModule(row.module);
          return;
        }
        onSelectWorkspaceFile(row.path);
      },
    });

    items.push({
      id: "open-text-editor",
      label: "Open Text Editor",
      action: () => onSelectWorkspaceFile(row.path),
    });

    if (isExpandableNode(row)) {
      items.push({
        id: "toggle-outline",
        label: expandedIds.has(row.id) ? "Collapse Outline" : "Expand Outline",
        action: () => onToggleExpansion(row.id),
      });
    }
  }

  if (row.kind === "outline" && row.outlineItem) {
    items.push(
      {
        id: "open-symbol",
        label: "Open Symbol",
        action: () => onSelectSymbol(row.outlineItem!.nodeId),
      },
      {
        id: "open-parent-file",
        label: "Open File",
        action: () => {
          if (row.module) {
            onSelectModule(row.module);
          }
        },
      },
    );
  }

  if (row.kind === "file" || row.kind === "directory") {
    items.push({
      id: "delete-entry",
      label: "Delete",
      action: () => onDeleteWorkspaceRow(row),
      separatorBefore: true,
    });
  }

  items.push(
    {
      id: "reveal-path",
      label: revealLabel,
      action: () => onRevealPathInFileExplorer(row.path),
      separatorBefore: true,
    },
    {
      id: "open-default",
      label: row.kind === "directory" ? "Open Folder" : "Open in Default App",
      action: () => onOpenPathInDefaultEditor(row.path),
    },
    {
      id: "copy-relative-path",
      label: "Copy Relative Path",
      action: () => copyToClipboard(row.path),
      separatorBefore: true,
    },
    {
      id: "copy-absolute-path",
      label: "Copy Absolute Path",
      action: () => copyToClipboard(absolutePath),
    },
  );

  if (row.kind === "file" && row.module) {
    items.push({
      id: "copy-module-id",
      label: "Copy Module ID",
      action: () => copyToClipboard(row.module!.moduleId),
    });
  }

  if (row.kind === "outline" && row.outlineItem) {
    items.push({
      id: "copy-symbol-id",
      label: "Copy Symbol ID",
      action: () => copyToClipboard(row.outlineItem!.nodeId),
    });
  }

  return items;
}
