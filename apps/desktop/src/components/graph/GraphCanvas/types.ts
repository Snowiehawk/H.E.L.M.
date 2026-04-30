import type { Edge, Node } from "@xyflow/react";
import type { GraphEdgeKind } from "../../../lib/adapter";
import type { UndoEntry } from "../../../store/undoStore";
import type { AppContextMenuPosition } from "../../shared/AppContextMenu";
import type { BlueprintEdgeData } from "../BlueprintEdge";
import type { BlueprintNodeData } from "../BlueprintNode";
import type { FlowLoopType } from "../flowDocument";
import type { StoredGraphGroup, StoredGraphLayout } from "../graphLayoutPersistence";
import type { RerouteNodeData } from "../RerouteNode";

export type SemanticCanvasNode = Node<BlueprintNodeData, "blueprint">;
export type RerouteCanvasNode = Node<RerouteNodeData, "reroute">;
export type GraphCanvasNode = SemanticCanvasNode | RerouteCanvasNode;
export type GraphCanvasEdge = Edge<BlueprintEdgeData, "blueprint">;

export type GraphContextMenuState =
  | (AppContextMenuPosition & {
      kind: "node";
      nodeId: string;
      focusElement?: HTMLElement | null;
    })
  | (AppContextMenuPosition & {
      kind: "edge";
      edgeId: string;
      edgeKind: GraphEdgeKind;
      edgeLabel?: string;
      segmentIndex: number;
      flowPosition: { x: number; y: number };
      focusElement?: HTMLElement | null;
    })
  | (AppContextMenuPosition & {
      kind: "pane";
      flowPosition: { x: number; y: number };
      focusElement?: HTMLElement | null;
    });

export type CreateModeState = "inactive" | "active" | "composing";

export interface GraphCreateIntent {
  flowPosition: { x: number; y: number };
  panelPosition: { x: number; y: number };
  seedFlowConnection?: {
    sourceNodeId: string;
    sourceHandle: "body" | "after";
    label: "Repeat" | "Done";
  };
}

export interface GraphFlowEditIntent {
  nodeId: string;
  flowPosition: { x: number; y: number };
  panelPosition: { x: number; y: number };
  initialLoopType?: FlowLoopType;
}

export interface GraphExpressionGraphIntent {
  nodeId: string;
  expressionNodeId?: string;
  flowPosition: { x: number; y: number };
  panelPosition: { x: number; y: number };
}

export interface GraphFlowConnectionIntent {
  sourceId: string;
  sourceHandle?: string | null;
  targetId: string;
  targetHandle?: string | null;
}

export interface GraphFlowDeleteIntent {
  nodeIds: string[];
  edgeIds: string[];
}

export type EdgeLabelSegment = {
  id: string;
  label: string;
  source: string;
  target: string;
  sourceHandle: string | null | undefined;
  targetHandle: string | null | undefined;
};

export interface CollapsedEdgeLabel {
  label?: string;
  count?: number;
}

export interface GroupMembership {
  groupByNodeId: Map<string, string>;
  memberNodeIdsByGroupId: Map<string, string[]>;
}

export interface GraphGroupBounds extends StoredGraphGroup {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MergeGroupsForSelectionResult {
  changed: boolean;
  nextGroupId?: string;
  nextGroups: StoredGraphGroup[];
}

export interface UngroupGroupsForSelectionResult {
  changed: boolean;
  nextGroups: StoredGraphGroup[];
  removedGroupIds: string[];
}

export interface LayoutUndoStackEntry {
  viewKey: string;
  layout: StoredGraphLayout;
  entry: UndoEntry;
}

export function isSemanticCanvasNode(node: GraphCanvasNode): node is SemanticCanvasNode {
  return node.type === "blueprint";
}

export function isRerouteCanvasNode(node: GraphCanvasNode): node is RerouteCanvasNode {
  return node.type === "reroute";
}
