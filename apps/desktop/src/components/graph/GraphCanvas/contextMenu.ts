import type { GraphNodeDto, GraphNodeKind, GraphView } from "../../../lib/adapter";
import {
  isEnterableGraphNodeKind,
  isGraphSymbolNodeKind,
  isInspectableGraphNodeKind,
} from "../../../lib/adapter";
import {
  copyToClipboard,
  systemFileExplorerLabel,
  type AppContextMenuItem,
  type AppContextMenuPosition,
} from "../../shared/AppContextMenu";
import type { FlowLoopType } from "../flowDocument";
import type { StoredGraphGroup } from "../graphLayoutPersistence";
import { metadataString, relativePathForGraphNode } from "./canvasNodes";
import type {
  GraphCanvasNode,
  GraphContextMenuState,
  GraphCreateIntent,
  GraphFlowEditIntent,
} from "./types";
import { isRerouteCanvasNode } from "./types";

type GraphPosition = { x: number; y: number };

export type BuildGraphContextMenuItemsDeps = {
  graph?: GraphView;
  nodes: GraphCanvasNode[];
  graphNodeById: Map<string, GraphNodeDto>;
  groupByNodeId: Map<string, string>;
  memberNodeIdsByGroupId: Map<string, string[]>;
  groups: StoredGraphGroup[];
  flowAuthoringEnabled: boolean;
  selectedControlEdgeIds: string[];
  selectedDeletableFlowNodeIds: string[];
  authorableFlowNodeIds: Set<string>;
  canPinNodes: boolean;
  effectiveSemanticSelection: string[];
  groupedNodeIds: Set<string>;
  selectedGroupId?: string;
  selectedRerouteCount: number;
  currentLayoutUndoStackLength: number;
  createModeActive: boolean;
  screenToFlowPosition: (position: GraphPosition) => GraphPosition;
  panelPositionForContext: (position: AppContextMenuPosition) => GraphPosition;
  removeSelectedReroutes: () => void;
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void;
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void;
  requestExpressionGraphIntent: (
    nodeId: string,
    expressionNodeId?: string,
    clientPosition?: GraphPosition,
  ) => void;
  onEditFlowNodeIntent: (intent: GraphFlowEditIntent) => void;
  onCreateIntent: (intent: GraphCreateIntent) => void;
  togglePinnedNodes: (nodeIds: string[]) => void;
  createGroupFromSelection: () => void;
  selectGroup: (groupId: string) => void;
  setSelectedSemanticNodeIds: (nodeIds: string[]) => void;
  ungroupGroup: (groupId: string, title: string) => void | Promise<void>;
  deleteSelectedFlowItems: () => void;
  onRevealNodeInFileExplorer?: (nodeId: string) => void | Promise<void>;
  onOpenNodeInDefaultEditor?: (nodeId: string) => void | Promise<void>;
  selectControlEdge: (edgeId: string) => void;
  onDisconnectFlowEdge: (edgeId: string) => void;
  clearSelectedControlEdge: (edgeId: string) => void;
  handleInsertReroute: (
    logicalEdgeId: string,
    segmentIndex: number,
    position: GraphPosition,
  ) => void;
  handleFitView: () => void;
  handleDeclutter: () => void;
  handleUndoLayout: () => void;
  ungroupSelection: () => void;
  clearLocalSelection: () => void;
  onClearSelection: () => void;
  onToggleCreateMode: () => void;
};

export function buildNodeContextMenuItems(
  menu: Extract<GraphContextMenuState, { kind: "node" }>,
  deps: BuildGraphContextMenuItemsDeps,
): AppContextMenuItem[] {
  const canvasNode = deps.nodes.find((node) => node.id === menu.nodeId);
  if (!canvasNode) {
    return [];
  }

  if (isRerouteCanvasNode(canvasNode)) {
    return [
      {
        id: "remove-reroute",
        label: "Remove Reroute",
        action: deps.removeSelectedReroutes,
      },
      {
        id: "copy-reroute-id",
        label: "Copy Reroute ID",
        action: () => copyToClipboard(canvasNode.id),
        separatorBefore: true,
      },
      {
        id: "copy-reroute-edge-id",
        label: "Copy Edge ID",
        action: () => copyToClipboard(canvasNode.data.logicalEdgeId),
      },
    ];
  }

  const graphNode = deps.graphNodeById.get(menu.nodeId);
  if (!graphNode) {
    return [];
  }

  const relativePath = relativePathForGraphNode(graphNode);
  const qualname = metadataString(graphNode, "qualname");
  const sourceBacked =
    Boolean(relativePath) || graphNode.kind === "module" || isGraphSymbolNodeKind(graphNode.kind);
  const groupId = deps.groupByNodeId.get(graphNode.id);
  const selectedGroupMemberIds = groupId ? (deps.memberNodeIdsByGroupId.get(groupId) ?? []) : [];
  const canDeleteFlowItems =
    deps.flowAuthoringEnabled &&
    (deps.selectedControlEdgeIds.length > 0 || deps.selectedDeletableFlowNodeIds.length > 0);
  const items: AppContextMenuItem[] = [];

  if (isEnterableGraphNodeKind(graphNode.kind)) {
    items.push({
      id: "enter",
      label: "Enter Node",
      action: () => deps.onActivateNode(graphNode.id, graphNode.kind),
    });
  }

  if (isInspectableGraphNodeKind(graphNode.kind)) {
    items.push({
      id: "inspect",
      label: "Inspect Source",
      action: () => deps.onInspectNode(graphNode.id, graphNode.kind),
    });
  }

  if (deps.flowAuthoringEnabled && graphNode.kind === "return") {
    items.push({
      id: "open-expression-graph",
      label: "Open Expression Graph",
      action: () =>
        deps.requestExpressionGraphIntent(graphNode.id, undefined, {
          x: menu.x,
          y: menu.y,
        }),
    });
  }

  if (deps.flowAuthoringEnabled && deps.authorableFlowNodeIds.has(graphNode.id)) {
    const openFlowNodeEditor = (initialLoopType?: FlowLoopType) =>
      deps.onEditFlowNodeIntent({
        nodeId: graphNode.id,
        flowPosition: deps.screenToFlowPosition({ x: menu.x, y: menu.y }),
        panelPosition: deps.panelPositionForContext(menu),
        initialLoopType,
      });
    if (graphNode.kind === "loop") {
      items.push(
        {
          id: "edit-loop",
          label: "Edit Loop",
          action: () => openFlowNodeEditor(),
        },
        {
          id: "change-loop-while",
          label: "Change to While Loop",
          action: () => openFlowNodeEditor("while"),
        },
        {
          id: "change-loop-for",
          label: "Change to For Loop",
          action: () => openFlowNodeEditor("for"),
        },
        {
          id: "add-repeat-step",
          label: "Add Repeat Step",
          action: () =>
            deps.onCreateIntent({
              flowPosition: deps.screenToFlowPosition({ x: menu.x, y: menu.y }),
              panelPosition: deps.panelPositionForContext(menu),
              seedFlowConnection: {
                sourceNodeId: graphNode.id,
                sourceHandle: "body",
                label: "Repeat",
              },
            }),
        },
        {
          id: "add-done-step",
          label: "Add Done Step",
          action: () =>
            deps.onCreateIntent({
              flowPosition: deps.screenToFlowPosition({ x: menu.x, y: menu.y }),
              panelPosition: deps.panelPositionForContext(menu),
              seedFlowConnection: {
                sourceNodeId: graphNode.id,
                sourceHandle: "after",
                label: "Done",
              },
            }),
        },
      );
    } else {
      items.push({
        id: "edit-flow-node",
        label: "Edit Flow Node",
        action: () => openFlowNodeEditor(),
      });
    }
  }

  if (deps.canPinNodes) {
    items.push({
      id: "toggle-pin",
      label: canvasNode.data.isPinned ? "Unpin Node" : "Pin Node",
      action: () => deps.togglePinnedNodes([graphNode.id]),
      separatorBefore: items.length > 0,
    });
  }

  if (deps.effectiveSemanticSelection.length > 1) {
    items.push({
      id: "group-selection",
      label: "Group Selection",
      action: deps.createGroupFromSelection,
      separatorBefore: items.length > 0,
    });
  }

  if (groupId) {
    items.push(
      {
        id: "select-group",
        label: "Select Group",
        action: () => deps.selectGroup(groupId),
        separatorBefore: deps.effectiveSemanticSelection.length <= 1 && items.length > 0,
      },
      {
        id: "ungroup-node-group",
        label: "Ungroup",
        action: () => {
          deps.setSelectedSemanticNodeIds(selectedGroupMemberIds);
          void deps.ungroupGroup(
            groupId,
            deps.groups.find((group) => group.id === groupId)?.title ?? groupId,
          );
        },
      },
    );
  }

  if (canDeleteFlowItems) {
    items.push({
      id: "delete-flow-selection",
      label: "Delete Flow Selection",
      action: deps.deleteSelectedFlowItems,
      separatorBefore: items.length > 0,
    });
  }

  if (sourceBacked && deps.onRevealNodeInFileExplorer) {
    items.push({
      id: "reveal-node",
      label: systemFileExplorerLabel(),
      action: () => deps.onRevealNodeInFileExplorer?.(graphNode.id),
      separatorBefore: items.length > 0,
    });
  }

  if (sourceBacked && deps.onOpenNodeInDefaultEditor) {
    items.push({
      id: "open-default",
      label: "Open in Default Editor",
      action: () => deps.onOpenNodeInDefaultEditor?.(graphNode.id),
    });
  }

  items.push(
    {
      id: "copy-label",
      label: "Copy Label",
      action: () => copyToClipboard(graphNode.label),
      separatorBefore: true,
    },
    {
      id: "copy-node-id",
      label: "Copy Node ID",
      action: () => copyToClipboard(graphNode.id),
    },
    {
      id: "copy-kind",
      label: "Copy Kind",
      action: () => copyToClipboard(graphNode.kind),
    },
  );

  if (relativePath) {
    items.push({
      id: "copy-relative-path",
      label: "Copy Relative Path",
      action: () => copyToClipboard(relativePath),
    });
  }

  if (qualname) {
    items.push({
      id: "copy-qualname",
      label: "Copy Qualified Name",
      action: () => copyToClipboard(qualname),
    });
  }

  return items;
}

export function buildEdgeContextMenuItems(
  menu: Extract<GraphContextMenuState, { kind: "edge" }>,
  deps: BuildGraphContextMenuItemsDeps,
): AppContextMenuItem[] {
  const canModifyFlowEdge =
    deps.flowAuthoringEnabled &&
    (menu.edgeKind === "controls" ||
      menu.edgeId.startsWith("data:flowbinding:") ||
      menu.edgeId.startsWith("data:flowparam:"));
  const items: AppContextMenuItem[] = [];

  if (canModifyFlowEdge) {
    items.push(
      {
        id: "select-edge",
        label: "Select Edge",
        action: () => deps.selectControlEdge(menu.edgeId),
      },
      {
        id: "disconnect-edge",
        label: "Disconnect Edge",
        action: () => {
          deps.onDisconnectFlowEdge(menu.edgeId);
          deps.clearSelectedControlEdge(menu.edgeId);
        },
      },
    );
  }

  items.push({
    id: "insert-reroute",
    label: "Insert Reroute",
    action: () => deps.handleInsertReroute(menu.edgeId, menu.segmentIndex, menu.flowPosition),
    separatorBefore: items.length > 0,
  });

  items.push(
    {
      id: "copy-edge-id",
      label: "Copy Edge ID",
      action: () => copyToClipboard(menu.edgeId),
      separatorBefore: true,
    },
    {
      id: "copy-edge-kind",
      label: "Copy Edge Kind",
      action: () => copyToClipboard(menu.edgeKind),
    },
  );

  if (menu.edgeLabel) {
    items.push({
      id: "copy-edge-label",
      label: "Copy Edge Label",
      action: () => copyToClipboard(menu.edgeLabel ?? ""),
    });
  }

  return items;
}

export function buildPaneContextMenuItems(
  menu: Extract<GraphContextMenuState, { kind: "pane" }>,
  deps: BuildGraphContextMenuItemsDeps,
): AppContextMenuItem[] {
  if (!deps.graph) {
    return [];
  }

  const canDeleteFlowItems =
    deps.flowAuthoringEnabled &&
    (deps.selectedControlEdgeIds.length > 0 || deps.selectedDeletableFlowNodeIds.length > 0);
  const items: AppContextMenuItem[] = [];

  if (deps.flowAuthoringEnabled) {
    items.push({
      id: "create-flow-node",
      label: "Create Flow Node Here",
      action: () =>
        deps.onCreateIntent({
          flowPosition: menu.flowPosition,
          panelPosition: deps.panelPositionForContext(menu),
        }),
    });
  }

  items.push(
    {
      id: "fit-view",
      label: "Fit View",
      action: () => {
        deps.handleFitView();
      },
      separatorBefore: items.length > 0,
    },
    {
      id: "declutter",
      label: deps.graph.level === "flow" ? "Auto Layout Flow" : "Declutter Layout",
      action: deps.handleDeclutter,
    },
    {
      id: "undo-layout",
      label: "Undo Layout",
      action: deps.handleUndoLayout,
      disabled: deps.currentLayoutUndoStackLength === 0,
    },
  );

  if (deps.effectiveSemanticSelection.length > 1) {
    items.push({
      id: "group-selection",
      label: "Group Selection",
      action: deps.createGroupFromSelection,
      separatorBefore: true,
    });
  }

  if (
    deps.selectedGroupId ||
    deps.effectiveSemanticSelection.some((nodeId) => deps.groupedNodeIds.has(nodeId))
  ) {
    items.push({
      id: "ungroup-selection",
      label: "Ungroup Selection",
      action: deps.ungroupSelection,
      separatorBefore: deps.effectiveSemanticSelection.length <= 1,
    });
  }

  if (canDeleteFlowItems) {
    items.push({
      id: "delete-flow-selection",
      label: "Delete Flow Selection",
      action: deps.deleteSelectedFlowItems,
      separatorBefore: true,
    });
  }

  if (
    deps.effectiveSemanticSelection.length ||
    deps.selectedControlEdgeIds.length ||
    deps.selectedRerouteCount ||
    deps.selectedGroupId
  ) {
    items.push({
      id: "clear-selection",
      label: "Clear Selection",
      action: () => {
        deps.clearLocalSelection();
        deps.onClearSelection();
      },
      separatorBefore: !canDeleteFlowItems,
    });
  }

  items.push(
    {
      id: "toggle-create-mode",
      label: deps.createModeActive ? "Exit Create Mode" : "Enter Create Mode",
      action: deps.onToggleCreateMode,
      separatorBefore: true,
    },
    {
      id: "copy-graph-target",
      label: "Copy Graph Target ID",
      action: () => copyToClipboard(deps.graph?.targetId ?? ""),
      separatorBefore: true,
    },
    {
      id: "copy-graph-level",
      label: "Copy Graph Level",
      action: () => copyToClipboard(deps.graph?.level ?? ""),
    },
  );

  return items;
}

export function buildGraphContextMenuItems(
  menu: GraphContextMenuState,
  deps: BuildGraphContextMenuItemsDeps,
) {
  if (menu.kind === "node") {
    return buildNodeContextMenuItems(menu, deps);
  }
  if (menu.kind === "edge") {
    return buildEdgeContextMenuItems(menu, deps);
  }
  return buildPaneContextMenuItems(menu, deps);
}

export function buildGraphContextMenuLabel(
  menu: GraphContextMenuState | null,
  graphNodeById: Map<string, GraphNodeDto>,
) {
  if (!menu) {
    return "Graph actions";
  }
  if (menu.kind === "node") {
    return `${graphNodeById.get(menu.nodeId)?.label ?? "Node"} actions`;
  }
  if (menu.kind === "edge") {
    return `${menu.edgeLabel ?? menu.edgeKind} edge actions`;
  }
  return "Graph actions";
}
