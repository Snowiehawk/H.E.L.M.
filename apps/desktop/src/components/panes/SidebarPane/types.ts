import type {
  BackendStatus,
  OverviewData,
  OverviewModule,
  OverviewOutlineItem,
  SearchResult,
  WorkspaceFileEntry,
  WorkspaceFileMoveRequest,
  WorkspaceFileMutationRequest,
  WorkspaceFileTree,
} from "../../../lib/adapter";

export type ExplorerTreeNodeKind = "directory" | "file" | "outline";

export interface ExplorerTreeNode {
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

export interface ExplorerTreeData {
  nodesById: Map<string, ExplorerTreeNode>;
  rootIds: string[];
}

export interface ExplorerContextMenuState {
  rowId: string;
  x: number;
  y: number;
}

export interface ExplorerContextMenuItem {
  id: string;
  label: string;
  action: () => void | Promise<void>;
  separatorBefore?: boolean;
}

export interface ExplorerCreateDraft {
  kind: WorkspaceFileMutationRequest["kind"];
  parentPath?: string;
  relativePath: string;
  isSubmitting: boolean;
  error: string | null;
}

export interface ExplorerDragState {
  rowId: string;
  kind: "file" | "directory";
  path: string;
}

export interface SidebarPaneProps {
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
  onOpenPathInDefaultEditor: (relativePath: string) => void | Promise<void>;
  onRevealPathInFileExplorer: (relativePath: string) => void | Promise<void>;
}
