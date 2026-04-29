import type { FlowGraphDocument, FlowGraphNode, FlowVisualNodeKind } from "../../../lib/adapter";
import { flowConnectionId } from "./ids";
import {
  type AuthoredFlowNode,
  type AuthoredFlowNodeKind,
  type FlowLoopDraft,
  type FlowLoopType,
} from "./model";

export function createFlowNode(symbolId: string, kind: AuthoredFlowNodeKind): AuthoredFlowNode {
  const unique =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return {
    id: `flowdoc:${symbolId}:${kind}:${unique}`,
    kind,
    payload: defaultPayloadForKind(kind),
    indexedNodeId: null,
  };
}

export function defaultPayloadForKind(kind: AuthoredFlowNodeKind) {
  if (kind === "assign" || kind === "call") {
    return { source: "" };
  }
  if (kind === "branch") {
    return { condition: "" };
  }
  if (kind === "loop") {
    return flowLoopPayloadFromDraft({
      loopType: "while",
      condition: "",
      target: "",
      iterable: "",
    });
  }
  return { expression: "" };
}

export function flowNodePayloadFromContent(
  kind: AuthoredFlowNodeKind,
  content: string,
): Record<string, unknown> {
  const normalized = content.trim();
  if (kind === "assign" || kind === "call") {
    return { source: normalized };
  }
  if (kind === "branch") {
    return { condition: normalized.replace(/^if\s+/i, "").replace(/:$/, "") };
  }
  if (kind === "loop") {
    return flowLoopPayloadFromDraft(
      normalizeFlowLoopPayload({ header: normalized.replace(/:$/, "") }),
    );
  }
  return { expression: normalized.replace(/^return\s+/i, "") };
}

export function flowNodeContentFromPayload(
  kind: AuthoredFlowNodeKind,
  payload: Record<string, unknown>,
): string {
  if (kind === "assign" || kind === "call") {
    return typeof payload.source === "string" ? payload.source : "";
  }
  if (kind === "branch") {
    const condition = typeof payload.condition === "string" ? payload.condition : "";
    return condition ? `if ${condition}` : "";
  }
  if (kind === "loop") {
    return normalizeFlowLoopPayload(payload).header;
  }
  const expression = typeof payload.expression === "string" ? payload.expression : "";
  return expression ? `return ${expression}` : "return";
}

export function normalizeFlowLoopPayload(
  payload: Record<string, unknown>,
): FlowLoopDraft & { header: string } {
  const rawHeader =
    typeof payload.header === "string" ? payload.header.trim().replace(/:$/, "") : "";
  const inferred = inferFlowLoopDraftFromHeader(rawHeader);
  const rawLoopType =
    typeof payload.loop_type === "string"
      ? payload.loop_type
      : typeof payload.loopType === "string"
        ? payload.loopType
        : undefined;
  const loopType: FlowLoopType =
    rawLoopType === "for_each" || rawLoopType === "for"
      ? "for"
      : rawLoopType === "while"
        ? "while"
        : (inferred?.loopType ?? "while");
  const condition =
    typeof payload.condition === "string"
      ? payload.condition.trim()
      : loopType === "while" && inferred?.loopType === "while"
        ? inferred.condition
        : "";
  const target =
    typeof payload.target === "string"
      ? payload.target.trim()
      : loopType === "for" && inferred?.loopType === "for"
        ? inferred.target
        : "";
  const iterable =
    typeof payload.iterable === "string"
      ? payload.iterable.trim()
      : loopType === "for" && inferred?.loopType === "for"
        ? inferred.iterable
        : "";
  const draft = { loopType, condition, target, iterable };
  const header = canonicalFlowLoopHeader(draft) || rawHeader;
  return { ...draft, header };
}

export function flowLoopPayloadFromDraft(draft: FlowLoopDraft): Record<string, unknown> {
  const header = canonicalFlowLoopHeader(draft);
  if (draft.loopType === "for") {
    return {
      header,
      loop_type: "for",
      target: draft.target.trim(),
      iterable: draft.iterable.trim(),
    };
  }
  return {
    header,
    loop_type: "while",
    condition: draft.condition.trim(),
  };
}

export function canonicalFlowLoopHeader(draft: FlowLoopDraft): string {
  if (draft.loopType === "for") {
    const target = draft.target.trim();
    const iterable = draft.iterable.trim();
    return target && iterable ? `for ${target} in ${iterable}` : "";
  }
  const condition = draft.condition.trim();
  return condition ? `while ${condition}` : "";
}

export function flowControlPathLabel(
  kind: FlowVisualNodeKind | string,
  sourceHandle: string,
): string {
  if (kind === "loop") {
    if (sourceHandle === "body") {
      return "Repeat";
    }
    if (sourceHandle === "after") {
      return "Done";
    }
  }
  return sourceHandle;
}

function inferFlowLoopDraftFromHeader(header: string): FlowLoopDraft | undefined {
  const normalized = header.trim().replace(/:$/, "");
  const whileMatch = /^while\s+(.+)$/i.exec(normalized);
  if (whileMatch) {
    return {
      loopType: "while",
      condition: whileMatch[1].trim(),
      target: "",
      iterable: "",
    };
  }
  const forMatch = /^for\s+(.+?)\s+in\s+(.+)$/i.exec(normalized);
  if (forMatch) {
    return {
      loopType: "for",
      condition: "",
      target: forMatch[1].trim(),
      iterable: forMatch[2].trim(),
    };
  }
  return undefined;
}

export function flowDocumentHandleFromBlueprintHandle(
  handleId: string | null | undefined,
  direction: "source" | "target",
): string | undefined {
  if (!handleId) {
    return undefined;
  }

  if (direction === "target") {
    return handleId === "in:control:exec" ? "in" : undefined;
  }

  return handleId.startsWith("out:control:") ? handleId.slice("out:control:".length) : undefined;
}

export function allowedOutputHandles(kind: FlowVisualNodeKind): string[] {
  if (kind === "entry") {
    return ["start"];
  }
  if (kind === "assign" || kind === "call") {
    return ["next"];
  }
  if (kind === "branch") {
    return ["true", "false"];
  }
  if (kind === "loop") {
    return ["body", "after"];
  }
  return [];
}

export function allowedInputHandles(kind: FlowVisualNodeKind): string[] {
  if (kind === "entry") {
    return [];
  }
  return ["in"];
}

export function updateFlowNodePayload(
  document: FlowGraphDocument,
  nodeId: string,
  payload: Record<string, unknown>,
): FlowGraphDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => (node.id === nodeId ? { ...node, payload } : node)),
  };
}

export function addDisconnectedFlowNode(
  document: FlowGraphDocument,
  node: FlowGraphNode,
): FlowGraphDocument {
  if (document.nodes.some((candidate) => candidate.id === node.id)) {
    return document;
  }

  return {
    ...document,
    nodes: [...document.nodes, node],
  };
}

export function insertFlowNodeOnEdge(
  document: FlowGraphDocument,
  node: AuthoredFlowNode,
  anchorEdgeId: string,
): FlowGraphDocument {
  const anchorEdge = document.edges.find((edge) => edge.id === anchorEdgeId);
  const seeded = addDisconnectedFlowNode(document, node);
  if (!anchorEdge) {
    return seeded;
  }

  return {
    ...seeded,
    edges: seeded.edges.flatMap((edge) => {
      if (edge.id !== anchorEdgeId) {
        return [edge];
      }

      const incomingEdge = {
        id: flowConnectionId({
          sourceId: edge.sourceId,
          sourceHandle: edge.sourceHandle,
          targetId: node.id,
          targetHandle: "in",
        }),
        sourceId: edge.sourceId,
        sourceHandle: edge.sourceHandle,
        targetId: node.id,
        targetHandle: "in",
      };
      if (node.kind === "return") {
        return [incomingEdge];
      }

      const continuationHandle = defaultFlowContinuationHandle(node.kind);
      return [
        incomingEdge,
        {
          id: flowConnectionId({
            sourceId: node.id,
            sourceHandle: continuationHandle,
            targetId: edge.targetId,
            targetHandle: edge.targetHandle,
          }),
          sourceId: node.id,
          sourceHandle: continuationHandle,
          targetId: edge.targetId,
          targetHandle: edge.targetHandle,
        },
      ];
    }),
  };
}

function defaultFlowContinuationHandle(kind: AuthoredFlowNodeKind) {
  if (kind === "branch") {
    return "true";
  }
  if (kind === "loop") {
    return "after";
  }
  return "next";
}
