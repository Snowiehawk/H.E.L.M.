import type {
  BackendUndoTransaction,
  FlowExpressionGraph,
  FlowGraphDocument,
  GraphBreadcrumbDto,
  GraphNodeDto,
  GraphNodeKind,
} from "../../lib/adapter";
import type { UndoEntry } from "../../store/undoStore";

export type InspectorSourceFetchMode = "editable" | "revealed";
export type InspectorSourceReason = "pinned" | "selected" | "flow-owner" | "module-context";

export interface InspectorSourceTarget {
  targetId: string;
  fetchMode: InspectorSourceFetchMode;
  node?: GraphNodeDto;
  nodeKind?: GraphNodeKind;
  reason: InspectorSourceReason;
}

export interface GraphPathItem {
  key: string;
  label: string;
  breadcrumb?: GraphBreadcrumbDto;
  revealPath?: string;
}

export type InspectorPanelMode = "hidden" | "collapsed" | "expanded";

export interface BackendUndoHistoryEntry {
  transaction: BackendUndoTransaction;
  entry: UndoEntry;
}

export type FlowDraftStatus = "idle" | "dirty" | "saving" | "reconcile-pending";

export interface FlowDraftState {
  symbolId: string;
  baseDocument: FlowGraphDocument;
  document: FlowGraphDocument;
  status: FlowDraftStatus;
  error: string | null;
  reconcileAfterUpdatedAt?: number;
}

export interface ReturnExpressionGraphViewState {
  symbolId: string;
  returnNodeId: string;
  selectedExpressionNodeId?: string;
  draftGraph?: FlowExpressionGraph;
  draftExpression?: string;
  diagnostics: string[];
  isDraftOnly: boolean;
  error: string | null;
}

export type ResolvedFlowInputBindingConnection =
  | {
      kind: "slot";
      sourceId: string;
      slotId: string;
    }
  | {
      kind: "return-input";
      sourceId: string;
      targetNodeId: string;
    };
