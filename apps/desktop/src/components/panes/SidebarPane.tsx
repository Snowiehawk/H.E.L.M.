import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  FormEvent as ReactFormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import type {
  BackendStatus,
  OverviewData,
  OverviewModule,
  OverviewOutlineItem,
  SearchResult,
  WorkspaceFileMoveRequest,
  WorkspaceFileMutationRequest,
  WorkspaceFileTree,
  WorkspaceFileEntry,
} from "../../lib/adapter";
import { StatusPill } from "../shared/StatusPill";
import {
  WorkspaceHelpBox,
  helpIdForOutlineKind,
  helpTargetProps,
} from "../workspace/workspaceHelp";

type ExplorerTreeNodeKind = "directory" | "file" | "outline";

interface ExplorerTreeNode {
  id: string;
  label: string;
  path: string;
  depth: number;
  kind: ExplorerTreeNodeKind;
  parentId?: string;
  childIds: string[];
  workspaceEntry?: WorkspaceFileEntry;
  module?: OverviewModule;
  outlineItem?: OverviewOutlineItem;
}

interface ExplorerTreeData {
  nodesById: Map<string, ExplorerTreeNode>;
  rootIds: string[];
}

interface ExplorerContextMenuState {
  rowId: string;
  x: number;
  y: number;
}

interface ExplorerContextMenuItem {
  id: string;
  label: string;
  action: () => void | Promise<void>;
  separatorBefore?: boolean;
}

interface ExplorerCreateDraft {
  kind: WorkspaceFileMutationRequest["kind"];
  parentPath?: string;
  relativePath: string;
  isSubmitting: boolean;
  error: string | null;
}

interface ExplorerDragState {
  rowId: string;
  kind: "file" | "directory";
  path: string;
}

const CONTEXT_MENU_WIDTH = 248;
const CONTEXT_MENU_MAX_HEIGHT = 336;
const CONTEXT_MENU_MARGIN = 8;

function compareExplorerNodes(left: ExplorerTreeNode, right: ExplorerTreeNode): number {
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

function buildExplorerTree(
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
    workspaceEntry?: WorkspaceFileEntry,
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

function buildVisibleExplorerRows(
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

function isExpandableNode(row: ExplorerTreeNode): boolean {
  return row.childIds.length > 0 && (row.kind === "directory" || row.kind === "file");
}

function isSelectedRow(
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

function findSelectedRowId(
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

function collectAncestorExpandedIds(tree: ExplorerTreeData, rowId: string | null): string[] {
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

function setsMatch(left: Set<string>, right: Set<string>): boolean {
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

function outlineKindBadge(kind: OverviewOutlineItem["kind"]): string {
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

function explorerKindBadge(row: ExplorerTreeNode): string | null {
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

function clampContextMenuPosition(x: number, y: number) {
  const viewportWidth = window.innerWidth || CONTEXT_MENU_WIDTH + CONTEXT_MENU_MARGIN * 2;
  const viewportHeight = window.innerHeight || CONTEXT_MENU_MAX_HEIGHT + CONTEXT_MENU_MARGIN * 2;
  return {
    x: Math.max(
      CONTEXT_MENU_MARGIN,
      Math.min(x, viewportWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN),
    ),
    y: Math.max(
      CONTEXT_MENU_MARGIN,
      Math.min(y, viewportHeight - CONTEXT_MENU_MAX_HEIGHT - CONTEXT_MENU_MARGIN),
    ),
  };
}

function joinRepoPath(repoPath: string | undefined, relativePath: string) {
  if (!repoPath) {
    return relativePath;
  }

  const normalizedRepoPath = repoPath.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedRelativePath = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  return `${normalizedRepoPath}/${normalizedRelativePath}`;
}

function systemFileExplorerLabel() {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) {
    return "Show in Finder";
  }
  if (platform.includes("win")) {
    return "Show in File Explorer";
  }
  return "Show in File Manager";
}

async function copyToClipboard(value: string) {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable in this window.");
  }

  await navigator.clipboard.writeText(value);
}

function contextActionError(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function defaultCreatePath(kind: WorkspaceFileMutationRequest["kind"], parentPath?: string) {
  const prefix = parentPath ? `${parentPath.replace(/\/+$/, "")}/` : "";
  return kind === "file" ? `${prefix}untitled.txt` : `${prefix}new-folder`;
}

function parentPathFor(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

function canDropExplorerRow(
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

export function SidebarPane({
  backendStatus,
  overview,
  workspaceFiles,
  sidebarQuery,
  searchResults,
  isSearching,
  selectedFilePath,
  selectedNodeId,
  onSidebarQueryChange,
  onSelectResult,
  onSelectModule,
  onSelectSymbol,
  onSelectWorkspaceFile,
  onCreateWorkspaceEntry,
  onMoveWorkspaceEntry,
  onDeleteWorkspaceEntry,
  onFocusRepoGraph,
  onReindexRepo,
  onOpenRepo,
  onOpenPathInDefaultEditor,
  onRevealPathInFileExplorer,
}: {
  backendStatus?: BackendStatus;
  overview?: OverviewData;
  workspaceFiles?: WorkspaceFileTree;
  sidebarQuery: string;
  searchResults: SearchResult[];
  isSearching: boolean;
  selectedFilePath?: string;
  selectedNodeId?: string;
  onSidebarQueryChange: (query: string) => void;
  onSelectResult: (result: SearchResult) => void;
  onSelectModule: (module: OverviewModule) => void;
  onSelectSymbol: (nodeId: string) => void;
  onSelectWorkspaceFile: (relativePath: string) => void;
  onCreateWorkspaceEntry: (request: WorkspaceFileMutationRequest) => Promise<void>;
  onMoveWorkspaceEntry: (request: WorkspaceFileMoveRequest) => Promise<void>;
  onDeleteWorkspaceEntry: (relativePath: string) => Promise<void>;
  onFocusRepoGraph: () => void;
  onReindexRepo: () => void;
  onOpenRepo: (path?: string) => void;
  onOpenPathInDefaultEditor: (filePath: string) => void | Promise<void>;
  onRevealPathInFileExplorer: (filePath: string) => void | Promise<void>;
}) {
  const tree = useMemo(
    () => buildExplorerTree(overview?.modules ?? [], workspaceFiles),
    [overview?.modules, workspaceFiles],
  );
  const selectedRowId = useMemo(
    () => findSelectedRowId(tree, selectedFilePath, selectedNodeId),
    [selectedFilePath, selectedNodeId, tree],
  );
  const selectedAncestorIds = useMemo(
    () => collectAncestorExpandedIds(tree, selectedRowId),
    [selectedRowId, tree],
  );
  const rootDirectoryIds = useMemo(
    () => tree.rootIds.filter((nodeId) => tree.nodesById.get(nodeId)?.kind === "directory"),
    [tree],
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ExplorerContextMenuState | null>(null);
  const [contextActionErrorMessage, setContextActionErrorMessage] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState<ExplorerCreateDraft | null>(null);
  const [dragState, setDragState] = useState<ExplorerDragState | null>(null);
  const [dropTargetRowId, setDropTargetRowId] = useState<string | null>(null);
  const previousRepoPathRef = useRef<string | undefined>(undefined);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSelectedRowScrollIdRef = useRef<string | null>(null);

  useEffect(() => {
    const repoPath = overview?.repo.path;

    setExpandedIds((current) => {
      const next = new Set<string>();
      const repoChanged = previousRepoPathRef.current !== repoPath;

      if (!repoChanged) {
        current.forEach((rowId) => {
          const row = tree.nodesById.get(rowId);
          if (row && isExpandableNode(row)) {
            next.add(rowId);
          }
        });
      } else {
        rootDirectoryIds.forEach((rowId) => next.add(rowId));
      }

      if (!current.size && !repoChanged) {
        rootDirectoryIds.forEach((rowId) => next.add(rowId));
      }

      selectedAncestorIds.forEach((rowId) => next.add(rowId));

      if (setsMatch(current, next)) {
        return current;
      }

      return next;
    });

    previousRepoPathRef.current = repoPath;
  }, [overview?.repo.path, rootDirectoryIds, selectedAncestorIds, tree]);

  const explorerRows = useMemo(
    () => buildVisibleExplorerRows(tree, expandedIds),
    [expandedIds, tree],
  );

  useEffect(() => {
    if (selectedRowId) {
      setActiveRowId(selectedRowId);
      return;
    }

    setActiveRowId((current) => {
      if (current && explorerRows.some((row) => row.id === current)) {
        return current;
      }

      return explorerRows[0]?.id ?? null;
    });
  }, [explorerRows, selectedRowId]);

  useEffect(() => {
    pendingSelectedRowScrollIdRef.current = selectedRowId ?? null;
  }, [selectedRowId]);

  useEffect(() => {
    if (!selectedRowId || pendingSelectedRowScrollIdRef.current !== selectedRowId) {
      return;
    }

    if (!explorerRows.some((row) => row.id === selectedRowId)) {
      return;
    }

    const selectedRowElement = rowRefs.current.get(selectedRowId);
    if (!selectedRowElement) {
      return;
    }

    selectedRowElement.scrollIntoView({ block: "nearest" });
    pendingSelectedRowScrollIdRef.current = null;
  }, [explorerRows, selectedRowId]);

  const focusRow = (rowId: string | null | undefined) => {
    if (!rowId) {
      return;
    }

    setActiveRowId(rowId);
    const rowElement = rowRefs.current.get(rowId);
    if (rowElement) {
      rowElement.focus();
      return;
    }

    window.requestAnimationFrame(() => {
      rowRefs.current.get(rowId)?.focus();
    });
  };

  const toggleExpansion = (rowId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  };

  const openContextMenuAt = (row: ExplorerTreeNode, x: number, y: number) => {
    const position = clampContextMenuPosition(x, y);
    setActiveRowId(row.id);
    setContextActionErrorMessage(null);
    setContextMenu({
      rowId: row.id,
      x: position.x,
      y: position.y,
    });
  };

  const openPointerContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    row: ExplorerTreeNode,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openContextMenuAt(row, event.clientX, event.clientY);
  };

  const openKeyboardContextMenu = (row: ExplorerTreeNode) => {
    const rowElement = rowRefs.current.get(row.id);
    const rect = rowElement?.getBoundingClientRect();
    openContextMenuAt(
      row,
      rect ? rect.left + Math.min(rect.width - 8, 180) : CONTEXT_MENU_MARGIN,
      rect ? rect.top + rect.height / 2 : CONTEXT_MENU_MARGIN,
    );
  };

  const closeContextMenu = (restoreFocus = false) => {
    const rowId = contextMenu?.rowId;
    setContextMenu(null);
    if (restoreFocus && rowId) {
      window.requestAnimationFrame(() => rowRefs.current.get(rowId)?.focus());
    }
  };

  const activateRow = (row: ExplorerTreeNode) => {
    setActiveRowId(row.id);
    if (row.kind === "directory") {
      toggleExpansion(row.id);
      return;
    }

    if (row.kind === "outline" && row.outlineItem) {
      onSelectSymbol(row.outlineItem.nodeId);
      return;
    }

    if (row.module) {
      onSelectModule(row.module);
      return;
    }

    if (row.kind === "file") {
      onSelectWorkspaceFile(row.path);
    }
  };

  const startCreateWorkspaceEntry = (
    kind: WorkspaceFileMutationRequest["kind"],
    parentPath?: string,
  ) => {
    setContextActionErrorMessage(null);
    setCreateDraft({
      kind,
      parentPath,
      relativePath: defaultCreatePath(kind, parentPath),
      isSubmitting: false,
      error: null,
    });
  };

  const submitCreateWorkspaceEntry = async (event?: ReactFormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!createDraft || createDraft.isSubmitting) {
      return;
    }

    const relativePath = createDraft.relativePath.trim();
    if (!relativePath) {
      setCreateDraft({
        ...createDraft,
        error: "Enter a repo-relative path.",
      });
      return;
    }

    setCreateDraft({
      ...createDraft,
      relativePath,
      isSubmitting: true,
      error: null,
    });

    try {
      await onCreateWorkspaceEntry({
        kind: createDraft.kind,
        relativePath,
        content: createDraft.kind === "file" ? "" : undefined,
      });

      if (createDraft.parentPath) {
        setExpandedIds((current) => {
          const next = new Set(current);
          next.add(`dir:${createDraft.parentPath}`);
          return next;
        });
      }

      setCreateDraft(null);
      setContextActionErrorMessage(null);
    } catch (reason) {
      setCreateDraft({
        ...createDraft,
        relativePath,
        isSubmitting: false,
        error: contextActionError(
          reason,
          createDraft.kind === "file"
            ? "Unable to create the file."
            : "Unable to create the folder.",
        ),
      });
    }
  };

  const beginDragRow = (event: ReactDragEvent<HTMLDivElement>, row: ExplorerTreeNode) => {
    if (row.kind !== "file" && row.kind !== "directory") {
      event.preventDefault();
      return;
    }

    const nextDragState: ExplorerDragState = {
      rowId: row.id,
      kind: row.kind,
      path: row.path,
    };
    setDragState(nextDragState);
    setContextActionErrorMessage(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", row.path);
    event.dataTransfer.setData("application/x-helm-workspace-entry", JSON.stringify(nextDragState));
  };

  const endDragRow = () => {
    setDragState(null);
    setDropTargetRowId(null);
  };

  const moveDraggedRowToDirectory = async (
    event: ReactDragEvent<HTMLDivElement>,
    target: ExplorerTreeNode,
  ) => {
    const source = dragState;
    if (!canDropExplorerRow(source, target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDropTargetRowId(null);
    try {
      await onMoveWorkspaceEntry({
        sourceRelativePath: source.path,
        targetDirectoryRelativePath: target.path,
      });
      setExpandedIds((current) => {
        const next = new Set(current);
        next.add(target.id);
        return next;
      });
      setContextActionErrorMessage(null);
    } catch (reason) {
      setContextActionErrorMessage(
        contextActionError(reason, "Unable to move the workspace entry."),
      );
    } finally {
      setDragState(null);
    }
  };

  const deleteWorkspaceRow = async (row: ExplorerTreeNode) => {
    if (row.kind !== "file" && row.kind !== "directory") {
      return;
    }
    await onDeleteWorkspaceEntry(row.path);
  };

  const buildContextMenuItems = (row: ExplorerTreeNode): ExplorerContextMenuItem[] => {
    const absolutePath = joinRepoPath(overview?.repo.path, row.path);
    const revealLabel = systemFileExplorerLabel();
    const items: ExplorerContextMenuItem[] = [];

    if (row.kind === "directory") {
      items.push({
        id: "toggle-folder",
        label: expandedIds.has(row.id) ? "Collapse Folder" : "Expand Folder",
        action: () => toggleExpansion(row.id),
      });
      items.push(
        {
          id: "new-file",
          label: "New File",
          action: () => startCreateWorkspaceEntry("file", row.path),
        },
        {
          id: "new-folder",
          label: "New Folder",
          action: () => startCreateWorkspaceEntry("directory", row.path),
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
          action: () => toggleExpansion(row.id),
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
        action: () => deleteWorkspaceRow(row),
        separatorBefore: true,
      });
    }

    items.push(
      {
        id: "reveal-path",
        label: revealLabel,
        action: () => onRevealPathInFileExplorer(absolutePath),
        separatorBefore: true,
      },
      {
        id: "open-default",
        label: row.kind === "directory" ? "Open Folder" : "Open in Default App",
        action: () => onOpenPathInDefaultEditor(absolutePath),
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
  };

  const runContextMenuItem = async (item: ExplorerContextMenuItem) => {
    setContextMenu(null);
    try {
      await item.action();
      setContextActionErrorMessage(null);
    } catch (reason) {
      setContextActionErrorMessage(
        contextActionError(reason, `Unable to run ${item.label.toLowerCase()}.`),
      );
    }
  };

  const handleContextMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      contextMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        items[(currentIndex + 1 + items.length) % items.length]?.focus();
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        items[(currentIndex - 1 + items.length) % items.length]?.focus();
        break;
      }
      case "Home":
        event.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case "Escape":
        event.preventDefault();
        closeContextMenu(true);
        break;
      default:
        break;
    }
  };

  const focusParent = (row: ExplorerTreeNode) => {
    if (row.parentId) {
      focusRow(row.parentId);
    }
  };

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      contextMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }

    const close = () => setContextMenu(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  const createDraftFocusKey = createDraft
    ? `${createDraft.kind}:${createDraft.parentPath ?? ""}`
    : null;

  useLayoutEffect(() => {
    if (!createDraftFocusKey) {
      return;
    }

    createInputRef.current?.focus();
    createInputRef.current?.select();
  }, [createDraftFocusKey]);

  const contextRow = contextMenu ? tree.nodesById.get(contextMenu.rowId) : undefined;
  const contextMenuItems = contextRow ? buildContextMenuItems(contextRow) : [];
  const createDraftLabel = createDraft?.kind === "directory" ? "folder" : "file";

  return (
    <aside className="pane pane--sidebar explorer-shell">
      <div className="explorer-header">
        <div>
          <span className="window-bar__eyebrow">Explorer</span>
          <h2>{overview?.repo.name ?? "Repository"}</h2>
          <p>{overview?.repo.path ?? "Open a repo to build the graph."}</p>
        </div>
        <StatusPill tone={backendStatus?.mode === "mock" ? "accent" : "default"}>
          {backendStatus?.mode === "mock" ? "Mock" : "Live"}
        </StatusPill>
      </div>

      <div className="explorer-actions">
        <button
          {...helpTargetProps("explorer.open-repo")}
          className="primary-button"
          type="button"
          onClick={() => onOpenRepo()}
        >
          Open Repo
        </button>
        <button
          {...helpTargetProps("explorer.reindex")}
          className="ghost-button"
          type="button"
          onClick={onReindexRepo}
        >
          Reindex
        </button>
        <button
          {...helpTargetProps("explorer.repo-graph")}
          className="ghost-button"
          type="button"
          onClick={onFocusRepoGraph}
        >
          Repo Graph
        </button>
      </div>

      {contextActionErrorMessage ? (
        <p className="error-copy explorer-context-error">{contextActionErrorMessage}</p>
      ) : null}

      <div className="sidebar-section">
        <div className="section-header">
          <h3>Search</h3>
          <span>Cmd/Ctrl + K</span>
        </div>
        <input
          {...helpTargetProps("explorer.search")}
          className="sidebar-search"
          value={sidebarQuery}
          onChange={(event) => onSidebarQueryChange(event.target.value)}
          placeholder="Jump to file or symbol"
        />
      </div>

      {sidebarQuery.trim() ? (
        <div className="sidebar-section explorer-results">
          {isSearching ? <p className="muted-copy">Searching current repo...</p> : null}
          {!isSearching && !searchResults.length ? (
            <p className="muted-copy">No files or symbols matched that query.</p>
          ) : null}
          {searchResults.map((result) => (
            <button
              key={result.id}
              {...helpTargetProps("explorer.search-result", { label: result.title })}
              className="list-button"
              type="button"
              onClick={() => onSelectResult(result)}
            >
              <span className="list-button__title">{result.title}</span>
              <span className="list-button__subtitle">{result.subtitle}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="sidebar-section explorer-tree">
          <div className="section-header">
            <h3>Files</h3>
            <span>
              {workspaceFiles
                ? `${workspaceFiles.entries.filter((entry) => entry.kind === "file").length}${workspaceFiles.truncated ? "+" : ""}`
                : (overview?.modules.length ?? 0)}
            </span>
          </div>
          <div className="explorer-create-actions">
            <button
              className="ghost-button ghost-button--compact"
              type="button"
              onClick={() => startCreateWorkspaceEntry("file")}
            >
              New File
            </button>
            <button
              className="ghost-button ghost-button--compact"
              type="button"
              onClick={() => startCreateWorkspaceEntry("directory")}
            >
              New Folder
            </button>
          </div>

          {createDraft ? (
            <form
              className="explorer-create-form"
              onSubmit={(event) => {
                void submitCreateWorkspaceEntry(event);
              }}
            >
              <label className="explorer-create-form__label">
                <span>{`New ${createDraftLabel}`}</span>
                <input
                  ref={createInputRef}
                  aria-label={`New ${createDraftLabel} path`}
                  className="explorer-create-form__input"
                  value={createDraft.relativePath}
                  disabled={createDraft.isSubmitting}
                  onChange={(event) => {
                    setCreateDraft({
                      ...createDraft,
                      relativePath: event.target.value,
                      error: null,
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setCreateDraft(null);
                    }
                  }}
                />
              </label>
              {createDraft.error ? (
                <p className="error-copy explorer-create-form__error">{createDraft.error}</p>
              ) : null}
              <div className="explorer-create-form__actions">
                <button
                  className="primary-button primary-button--compact"
                  type="submit"
                  disabled={createDraft.isSubmitting}
                >
                  {createDraft.isSubmitting ? "Creating..." : "Create"}
                </button>
                <button
                  className="ghost-button ghost-button--compact"
                  type="button"
                  disabled={createDraft.isSubmitting}
                  onClick={() => setCreateDraft(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {explorerRows.length ? (
            <div aria-label="Files" className="explorer-tree__rows" role="tree">
              {explorerRows.map((row, index) => {
                const isExpandable = isExpandableNode(row);
                const isExpanded = isExpandable && expandedIds.has(row.id);
                const isSelected = isSelectedRow(row, selectedFilePath, selectedNodeId);
                const kindBadge = explorerKindBadge(row);
                const isDraggable = row.kind === "file" || row.kind === "directory";
                const isDropTarget = dropTargetRowId === row.id;

                return (
                  <div
                    key={row.id}
                    {...helpTargetProps(
                      row.kind === "directory"
                        ? "explorer.directory"
                        : row.kind === "file"
                          ? "explorer.file"
                          : helpIdForOutlineKind(row.outlineItem?.kind ?? "function"),
                      { label: row.label },
                    )}
                    ref={(element) => {
                      if (element) {
                        rowRefs.current.set(row.id, element);
                        return;
                      }

                      rowRefs.current.delete(row.id);
                    }}
                    aria-expanded={isExpandable ? isExpanded : undefined}
                    aria-label={row.label}
                    aria-level={row.depth + 1}
                    aria-selected={isSelected || undefined}
                    draggable={isDraggable}
                    className={`explorer-row explorer-row--${row.kind}${
                      isSelected ? " is-active" : ""
                    }${activeRowId === row.id ? " is-focused" : ""}${
                      isExpanded ? " is-expanded" : ""
                    }${isDropTarget ? " is-drop-target" : ""}${
                      dragState?.rowId === row.id ? " is-dragging" : ""
                    }`}
                    role="treeitem"
                    tabIndex={activeRowId === row.id ? 0 : -1}
                    style={{ paddingLeft: `${12 + row.depth * 16}px` }}
                    onClick={() => activateRow(row)}
                    onContextMenu={(event) => openPointerContextMenu(event, row)}
                    onDragStart={(event) => beginDragRow(event, row)}
                    onDragEnd={endDragRow}
                    onDragEnter={(event) => {
                      if (!canDropExplorerRow(dragState, row)) {
                        return;
                      }
                      event.preventDefault();
                      setDropTargetRowId(row.id);
                    }}
                    onDragOver={(event) => {
                      if (!canDropExplorerRow(dragState, row)) {
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      if (dropTargetRowId !== row.id) {
                        setDropTargetRowId(row.id);
                      }
                    }}
                    onDragLeave={(event) => {
                      if (
                        dropTargetRowId === row.id &&
                        !event.currentTarget.contains(event.relatedTarget as Node | null)
                      ) {
                        setDropTargetRowId(null);
                      }
                    }}
                    onDrop={(event) => {
                      void moveDraggedRowToDirectory(event, row);
                    }}
                    onFocus={() => setActiveRowId(row.id)}
                    onKeyDown={(event) => {
                      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                        event.preventDefault();
                        openKeyboardContextMenu(row);
                        return;
                      }

                      switch (event.key) {
                        case "ArrowDown":
                          event.preventDefault();
                          focusRow(explorerRows[index + 1]?.id ?? row.id);
                          break;
                        case "ArrowUp":
                          event.preventDefault();
                          focusRow(explorerRows[index - 1]?.id ?? row.id);
                          break;
                        case "ArrowRight":
                          if (!isExpandable) {
                            break;
                          }

                          event.preventDefault();
                          if (!isExpanded) {
                            toggleExpansion(row.id);
                            break;
                          }

                          focusRow(row.childIds[0] ?? row.id);
                          break;
                        case "ArrowLeft":
                          event.preventDefault();
                          if (isExpandable && isExpanded) {
                            toggleExpansion(row.id);
                            break;
                          }

                          focusParent(row);
                          break;
                        case "Home":
                          event.preventDefault();
                          focusRow(explorerRows[0]?.id);
                          break;
                        case "End":
                          event.preventDefault();
                          focusRow(explorerRows[explorerRows.length - 1]?.id);
                          break;
                        case "Enter":
                        case " ":
                          event.preventDefault();
                          activateRow(row);
                          break;
                        case "Delete":
                          if (row.kind !== "file" && row.kind !== "directory") {
                            break;
                          }
                          event.preventDefault();
                          void deleteWorkspaceRow(row).catch((reason) => {
                            setContextActionErrorMessage(
                              contextActionError(reason, "Unable to delete the workspace entry."),
                            );
                          });
                          break;
                        default:
                          break;
                      }
                    }}
                  >
                    <button
                      {...helpTargetProps("explorer.disclosure", { label: row.label })}
                      aria-hidden={!isExpandable}
                      className={`explorer-row__disclosure${isExpandable ? "" : " is-hidden"}`}
                      tabIndex={-1}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!isExpandable) {
                          return;
                        }
                        toggleExpansion(row.id);
                        focusRow(row.id);
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      {isExpandable ? (isExpanded ? "▾" : "▸") : ""}
                    </button>

                    {kindBadge ? (
                      <span
                        className={`explorer-row__kind explorer-row__kind--${row.kind}`}
                        title={
                          row.kind === "outline"
                            ? row.outlineItem?.kind.replaceAll("_", " ")
                            : row.kind
                        }
                      >
                        {kindBadge}
                      </span>
                    ) : (
                      <span
                        aria-hidden="true"
                        className="explorer-row__kind explorer-row__kind--empty"
                      />
                    )}

                    <span className="explorer-row__label">{row.label}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="explorer-empty-actions">
              <p className="muted-copy">
                This workspace folder is empty. Create a file or folder to start shaping it.
              </p>
            </div>
          )}
        </div>
      )}

      <WorkspaceHelpBox />

      {contextMenu && contextRow ? (
        <div
          aria-hidden="false"
          className="context-menu-layer"
          onContextMenu={(event) => {
            event.preventDefault();
            closeContextMenu();
          }}
          onPointerDown={() => closeContextMenu()}
        >
          <div
            ref={contextMenuRef}
            aria-label={`${contextRow.label} actions`}
            className="explorer-context-menu"
            role="menu"
            style={{
              left: contextMenu.x,
              top: contextMenu.y,
            }}
            onKeyDown={handleContextMenuKeyDown}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {contextMenuItems.map((item) => (
              <div key={item.id} role="none">
                {item.separatorBefore ? (
                  <div className="context-menu__separator" role="separator" />
                ) : null}
                <button
                  className="context-menu__item"
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    void runContextMenuItem(item);
                  }}
                >
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
