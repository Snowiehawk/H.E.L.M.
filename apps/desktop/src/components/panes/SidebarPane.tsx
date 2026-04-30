import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  FormEvent as ReactFormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { clampAppContextMenuPosition, contextActionError } from "../shared/AppContextMenu";
import { WorkspaceHelpBox } from "../workspace/workspaceHelp";
import { buildExplorerContextMenuItems } from "./SidebarPane/contextMenu";
import { ExplorerContextMenu } from "./SidebarPane/ExplorerContextMenu";
import { ExplorerHeader } from "./SidebarPane/ExplorerHeader";
import { SearchResultsSection } from "./SidebarPane/SearchResultsSection";
import { SearchSection } from "./SidebarPane/SearchSection";
import {
  buildExplorerTree,
  buildVisibleExplorerRows,
  canDropExplorerRow,
  collectAncestorExpandedIds,
  defaultCreatePath,
  findSelectedRowId,
  isExpandableNode,
  setsMatch,
} from "./SidebarPane/treeModel";
import type {
  ExplorerContextMenuItem,
  ExplorerContextMenuState,
  ExplorerCreateDraft,
  ExplorerDragState,
  ExplorerTreeNode,
  SidebarPaneProps,
} from "./SidebarPane/types";
import { WorkspaceTreeSection } from "./SidebarPane/WorkspaceTreeSection";

const KEYBOARD_CONTEXT_MENU_MARGIN = 8;

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
}: SidebarPaneProps) {
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
    const position = clampAppContextMenuPosition(x, y);
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
      rect
        ? rect.left + Math.min(rect.width - KEYBOARD_CONTEXT_MENU_MARGIN, 180)
        : KEYBOARD_CONTEXT_MENU_MARGIN,
      rect ? rect.top + rect.height / 2 : KEYBOARD_CONTEXT_MENU_MARGIN,
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

  const startCreateWorkspaceEntry = (kind: ExplorerCreateDraft["kind"], parentPath?: string) => {
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

  const handleExplorerRowKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    row: ExplorerTreeNode,
    index: number,
  ) => {
    const isExpandable = isExpandableNode(row);
    const isExpanded = isExpandable && expandedIds.has(row.id);

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
  const contextMenuItems = contextRow
    ? buildExplorerContextMenuItems({
        expandedIds,
        onDeleteWorkspaceRow: deleteWorkspaceRow,
        onOpenPathInDefaultEditor,
        onRevealPathInFileExplorer,
        onSelectModule,
        onSelectSymbol,
        onSelectWorkspaceFile,
        onStartCreateWorkspaceEntry: startCreateWorkspaceEntry,
        onToggleExpansion: toggleExpansion,
        repoPath: overview?.repo.path,
        row: contextRow,
      })
    : [];
  const createDraftLabel = createDraft?.kind === "directory" ? "folder" : "file";

  return (
    <aside className="pane pane--sidebar explorer-shell">
      <ExplorerHeader
        backendStatus={backendStatus}
        overview={overview}
        onFocusRepoGraph={onFocusRepoGraph}
        onOpenRepo={onOpenRepo}
        onReindexRepo={onReindexRepo}
      />

      {contextActionErrorMessage ? (
        <p className="error-copy explorer-context-error">{contextActionErrorMessage}</p>
      ) : null}

      <SearchSection sidebarQuery={sidebarQuery} onSidebarQueryChange={onSidebarQueryChange} />

      {sidebarQuery.trim() ? (
        <SearchResultsSection
          isSearching={isSearching}
          searchResults={searchResults}
          onSelectResult={onSelectResult}
        />
      ) : (
        <WorkspaceTreeSection
          activeRowId={activeRowId}
          createDraft={createDraft}
          createDraftLabel={createDraftLabel}
          createInputRef={createInputRef}
          dragState={dragState}
          dropTargetRowId={dropTargetRowId}
          expandedIds={expandedIds}
          explorerRows={explorerRows}
          overview={overview}
          rowRefs={rowRefs}
          selectedFilePath={selectedFilePath}
          selectedNodeId={selectedNodeId}
          workspaceFiles={workspaceFiles}
          onActivateRow={activateRow}
          onBeginDragRow={beginDragRow}
          onCancelCreateDraft={() => setCreateDraft(null)}
          onChangeCreateDraftRelativePath={(relativePath) =>
            setCreateDraft((current) =>
              current ? { ...current, relativePath, error: null } : current,
            )
          }
          onEndDragRow={endDragRow}
          onMoveDraggedRowToDirectory={moveDraggedRowToDirectory}
          onOpenPointerContextMenu={openPointerContextMenu}
          onRowFocus={setActiveRowId}
          onRowKeyDown={handleExplorerRowKeyDown}
          onSetDropTargetRowId={setDropTargetRowId}
          onStartCreateWorkspaceEntry={startCreateWorkspaceEntry}
          onSubmitCreateWorkspaceEntry={submitCreateWorkspaceEntry}
          onToggleExpansion={(rowId) => {
            toggleExpansion(rowId);
            focusRow(rowId);
          }}
        />
      )}

      <WorkspaceHelpBox />

      {contextMenu && contextRow ? (
        <ExplorerContextMenu
          contextMenu={contextMenu}
          contextMenuItems={contextMenuItems}
          contextMenuRef={contextMenuRef}
          contextRow={contextRow}
          onClose={closeContextMenu}
          onKeyDown={handleContextMenuKeyDown}
          onRunItem={runContextMenuItem}
        />
      ) : null}
    </aside>
  );
}
