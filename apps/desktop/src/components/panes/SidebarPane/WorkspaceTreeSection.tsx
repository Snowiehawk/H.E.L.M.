import type {
  DragEvent as ReactDragEvent,
  FormEvent as ReactFormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  RefObject,
} from "react";
import type { OverviewData, WorkspaceFileTree } from "../../../lib/adapter";
import { helpIdForOutlineKind, helpTargetProps } from "../../workspace/workspaceHelp";
import {
  canDropExplorerRow,
  explorerKindBadge,
  isExpandableNode,
  isSelectedRow,
} from "./treeModel";
import type { ExplorerCreateDraft, ExplorerDragState, ExplorerTreeNode } from "./types";
import { WorkspaceCreateForm } from "./WorkspaceCreateForm";

export function WorkspaceTreeSection({
  activeRowId,
  createDraft,
  createDraftLabel,
  createInputRef,
  dragState,
  dropTargetRowId,
  expandedIds,
  explorerRows,
  overview,
  rowRefs,
  selectedFilePath,
  selectedNodeId,
  workspaceFiles,
  onActivateRow,
  onBeginDragRow,
  onCancelCreateDraft,
  onChangeCreateDraftRelativePath,
  onEndDragRow,
  onMoveDraggedRowToDirectory,
  onOpenPointerContextMenu,
  onRowFocus,
  onRowKeyDown,
  onSetDropTargetRowId,
  onStartCreateWorkspaceEntry,
  onSubmitCreateWorkspaceEntry,
  onToggleExpansion,
}: {
  activeRowId: string | null;
  createDraft: ExplorerCreateDraft | null;
  createDraftLabel: string;
  createInputRef: RefObject<HTMLInputElement>;
  dragState: ExplorerDragState | null;
  dropTargetRowId: string | null;
  expandedIds: Set<string>;
  explorerRows: ExplorerTreeNode[];
  overview?: OverviewData;
  rowRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  selectedFilePath?: string;
  selectedNodeId?: string;
  workspaceFiles?: WorkspaceFileTree;
  onActivateRow: (row: ExplorerTreeNode) => void;
  onBeginDragRow: (event: ReactDragEvent<HTMLDivElement>, row: ExplorerTreeNode) => void;
  onCancelCreateDraft: () => void;
  onChangeCreateDraftRelativePath: (relativePath: string) => void;
  onEndDragRow: () => void;
  onMoveDraggedRowToDirectory: (
    event: ReactDragEvent<HTMLDivElement>,
    target: ExplorerTreeNode,
  ) => void | Promise<void>;
  onOpenPointerContextMenu: (event: ReactMouseEvent<HTMLDivElement>, row: ExplorerTreeNode) => void;
  onRowFocus: (rowId: string) => void;
  onRowKeyDown: (
    event: ReactKeyboardEvent<HTMLDivElement>,
    row: ExplorerTreeNode,
    index: number,
  ) => void;
  onSetDropTargetRowId: (rowId: string | null) => void;
  onStartCreateWorkspaceEntry: (kind: "file" | "directory") => void;
  onSubmitCreateWorkspaceEntry: (event?: ReactFormEvent<HTMLFormElement>) => void | Promise<void>;
  onToggleExpansion: (rowId: string) => void;
}) {
  return (
    <div className="sidebar-section explorer-tree">
      <div className="section-header">
        <h3>Files</h3>
        <span>
          {workspaceFiles
            ? `${workspaceFiles.entries.filter((entry) => entry.kind === "file").length}${
                workspaceFiles.truncated ? "+" : ""
              }`
            : (overview?.modules.length ?? 0)}
        </span>
      </div>
      <div className="explorer-create-actions">
        <button
          className="ghost-button ghost-button--compact"
          type="button"
          onClick={() => onStartCreateWorkspaceEntry("file")}
        >
          New File
        </button>
        <button
          className="ghost-button ghost-button--compact"
          type="button"
          onClick={() => onStartCreateWorkspaceEntry("directory")}
        >
          New Folder
        </button>
      </div>

      {createDraft ? (
        <WorkspaceCreateForm
          createDraft={createDraft}
          createDraftLabel={createDraftLabel}
          inputRef={createInputRef}
          onCancel={onCancelCreateDraft}
          onChangeRelativePath={onChangeCreateDraftRelativePath}
          onSubmit={onSubmitCreateWorkspaceEntry}
        />
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
                onClick={() => onActivateRow(row)}
                onContextMenu={(event) => onOpenPointerContextMenu(event, row)}
                onDragStart={(event) => onBeginDragRow(event, row)}
                onDragEnd={onEndDragRow}
                onDragEnter={(event) => {
                  if (!canDropExplorerRow(dragState, row)) {
                    return;
                  }
                  event.preventDefault();
                  onSetDropTargetRowId(row.id);
                }}
                onDragOver={(event) => {
                  if (!canDropExplorerRow(dragState, row)) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (dropTargetRowId !== row.id) {
                    onSetDropTargetRowId(row.id);
                  }
                }}
                onDragLeave={(event) => {
                  if (
                    dropTargetRowId === row.id &&
                    !event.currentTarget.contains(event.relatedTarget as Node | null)
                  ) {
                    onSetDropTargetRowId(null);
                  }
                }}
                onDrop={(event) => {
                  void onMoveDraggedRowToDirectory(event, row);
                }}
                onFocus={() => onRowFocus(row.id)}
                onKeyDown={(event) => onRowKeyDown(event, row, index)}
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
                    onToggleExpansion(row.id);
                    onRowFocus(row.id);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                >
                  {isExpandable ? (isExpanded ? "\u25be" : "\u25b8") : ""}
                </button>

                {kindBadge ? (
                  <span
                    className={`explorer-row__kind explorer-row__kind--${row.kind}`}
                    title={
                      row.kind === "outline" ? row.outlineItem?.kind.replaceAll("_", " ") : row.kind
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
  );
}
