import type { FlowGraphDocument, FlowGraphNode, FlowVisualNodeKind } from "../../../lib/adapter";

export const FLOW_DOCUMENT_NODE_KINDS = [
  "entry",
  "assign",
  "call",
  "branch",
  "loop",
  "return",
  "exit",
] as const satisfies readonly FlowVisualNodeKind[];

export const FLOW_AUTHORABLE_NODE_KINDS = ["assign", "call", "return", "branch", "loop"] as const;

const FLOW_DOCUMENT_NODE_KIND_SET = new Set<string>(FLOW_DOCUMENT_NODE_KINDS);
const FLOW_AUTHORABLE_NODE_KIND_SET = new Set<string>(FLOW_AUTHORABLE_NODE_KINDS);

export type AuthoredFlowNodeKind = (typeof FLOW_AUTHORABLE_NODE_KINDS)[number];
export type AuthoredFlowNode = FlowGraphNode & { kind: AuthoredFlowNodeKind };
export type FlowLoopType = "while" | "for";

export interface FlowLoopDraft {
  loopType: FlowLoopType;
  condition: string;
  target: string;
  iterable: string;
}

export function isFlowNodeStructuralKind(
  kind: FlowVisualNodeKind | string,
): kind is "entry" | "exit" {
  return kind === "entry" || kind === "exit";
}

export function isFlowDocumentNodeKind(
  kind: FlowVisualNodeKind | string,
): kind is FlowVisualNodeKind {
  return FLOW_DOCUMENT_NODE_KIND_SET.has(kind);
}

export function isFlowNodeAuthorableKind(
  kind: FlowVisualNodeKind | string,
): kind is AuthoredFlowNodeKind {
  return FLOW_AUTHORABLE_NODE_KIND_SET.has(kind);
}

export function isAuthoredFlowNodeKind(
  kind: FlowVisualNodeKind | string,
): kind is AuthoredFlowNodeKind {
  return isFlowNodeAuthorableKind(kind);
}

export function cloneFlowDocument(document: FlowGraphDocument): FlowGraphDocument {
  return {
    ...document,
    diagnostics: [...document.diagnostics],
    nodes: document.nodes.map((node) => ({
      ...node,
      payload: { ...node.payload },
      indexedNodeId: node.indexedNodeId ?? null,
    })),
    edges: document.edges.map((edge) => ({ ...edge })),
    valueModelVersion: document.valueModelVersion ?? null,
    functionInputs: (document.functionInputs ?? []).map((input) => ({ ...input })),
    valueSources: (document.valueSources ?? []).map((source) => ({ ...source })),
    inputSlots: (document.inputSlots ?? []).map((slot) => ({ ...slot })),
    inputBindings: (document.inputBindings ?? []).map((binding) => ({ ...binding })),
  };
}

export function flowDocumentsEqual(
  left: FlowGraphDocument | undefined,
  right: FlowGraphDocument | undefined,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}
