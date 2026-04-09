import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BackendStatus,
  OverviewData,
  OverviewModule,
  OverviewOutlineItem,
  SearchResult,
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
  module?: OverviewModule;
  outlineItem?: OverviewOutlineItem;
}

interface ExplorerTreeData {
  nodesById: Map<string, ExplorerTreeNode>;
  rootIds: string[];
}

function compareExplorerNodes(
  left: ExplorerTreeNode,
  right: ExplorerTreeNode,
): number {
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

function buildExplorerTree(modules: OverviewModule[]): ExplorerTreeData {
  const nodesById = new Map<string, ExplorerTreeNode>();
  const rootIds: string[] = [];

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

  [...modules]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .forEach((module) => {
      const parts = module.relativePath.split("/").filter(Boolean);
      let parentId: string | undefined;

      parts.slice(0, -1).forEach((part, index) => {
        const path = parts.slice(0, index + 1).join("/");
        const directoryId = `dir:${path}`;

        if (!nodesById.has(directoryId)) {
          nodesById.set(directoryId, {
            id: directoryId,
            label: part,
            path,
            depth: index,
            kind: "directory",
            parentId,
            childIds: [],
          });
          appendChild(parentId, directoryId);
        }

        parentId = directoryId;
      });

      const fileId = `file:${module.relativePath}`;
      nodesById.set(fileId, {
        id: fileId,
        label: parts[parts.length - 1] ?? module.relativePath,
        path: module.relativePath,
        depth: Math.max(parts.length - 1, 0),
        kind: "file",
        parentId,
        childIds: [],
        module,
      });
      appendChild(parentId, fileId);

      const outline = module.outline ?? [];
      outline.forEach((outlineItem) => {
        const outlineId = `outline:${module.relativePath}:${outlineItem.nodeId}`;
        nodesById.set(outlineId, {
          id: outlineId,
          label: outlineItem.label,
          path: module.relativePath,
          depth: Math.max(parts.length, 0),
          kind: "outline",
          parentId: fileId,
          childIds: [],
          module,
          outlineItem,
        });
        appendChild(fileId, outlineId);
      });
    });

  rootIds.sort((leftId, rightId) =>
    compareExplorerNodes(nodesById.get(leftId)!, nodesById.get(rightId)!),
  );

  nodesById.forEach((node) => {
    if (node.kind !== "directory") {
      return;
    }

    node.childIds.sort((leftId, rightId) =>
      compareExplorerNodes(nodesById.get(leftId)!, nodesById.get(rightId)!),
    );
  });

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
    row.kind === "file"
    && (selectedFilePath === row.path || selectedNodeId === row.module?.moduleId)
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

function collectAncestorExpandedIds(
  tree: ExplorerTreeData,
  rowId: string | null,
): string[] {
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

export function SidebarPane({
  backendStatus,
  overview,
  sidebarQuery,
  searchResults,
  isSearching,
  selectedFilePath,
  selectedNodeId,
  onSidebarQueryChange,
  onSelectResult,
  onSelectModule,
  onSelectSymbol,
  onFocusRepoGraph,
  onReindexRepo,
  onOpenRepo,
}: {
  backendStatus?: BackendStatus;
  overview?: OverviewData;
  sidebarQuery: string;
  searchResults: SearchResult[];
  isSearching: boolean;
  selectedFilePath?: string;
  selectedNodeId?: string;
  onSidebarQueryChange: (query: string) => void;
  onSelectResult: (result: SearchResult) => void;
  onSelectModule: (module: OverviewModule) => void;
  onSelectSymbol: (nodeId: string) => void;
  onFocusRepoGraph: () => void;
  onReindexRepo: () => void;
  onOpenRepo: (path?: string) => void;
}) {
  const tree = useMemo(
    () => buildExplorerTree(overview?.modules ?? []),
    [overview?.modules],
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
    () =>
      tree.rootIds.filter((nodeId) => tree.nodesById.get(nodeId)?.kind === "directory"),
    [tree],
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const previousRepoPathRef = useRef<string | undefined>(undefined);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

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
    }
  };

  const focusParent = (row: ExplorerTreeNode) => {
    if (row.parentId) {
      focusRow(row.parentId);
    }
  };

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
            <span>{overview?.modules.length ?? 0}</span>
          </div>

          {explorerRows.length ? (
            <div aria-label="Files" className="explorer-tree__rows" role="tree">
              {explorerRows.map((row, index) => {
                const isExpandable = isExpandableNode(row);
                const isExpanded = isExpandable && expandedIds.has(row.id);
                const isSelected = isSelectedRow(row, selectedFilePath, selectedNodeId);

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
                    className={`explorer-row explorer-row--${row.kind}${
                      isSelected ? " is-active" : ""
                    }${activeRowId === row.id ? " is-focused" : ""}${
                      isExpanded ? " is-expanded" : ""
                    }`}
                    role="treeitem"
                    tabIndex={activeRowId === row.id ? 0 : -1}
                    style={{ paddingLeft: `${12 + row.depth * 16}px` }}
                    onClick={() => activateRow(row)}
                    onFocus={() => setActiveRowId(row.id)}
                    onKeyDown={(event) => {
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

                    {row.kind === "outline" && row.outlineItem ? (
                      <span
                        className="explorer-row__kind"
                        title={row.outlineItem.kind.replaceAll("_", " ")}
                      >
                        {outlineKindBadge(row.outlineItem.kind)}
                      </span>
                    ) : (
                      <span aria-hidden="true" className="explorer-row__kind explorer-row__kind--empty" />
                    )}

                    <span className="explorer-row__label">{row.label}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted-copy">
              Files will appear here as soon as indexing finishes.
            </p>
          )}
        </div>
      )}

      <WorkspaceHelpBox />
    </aside>
  );
}
