import type { GraphNodeDto } from "../../lib/adapter";
import { isGraphSymbolNodeKind } from "../../lib/adapter";

export function metadataString(node: GraphNodeDto | undefined, key: string): string | undefined {
  const camelKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const value = node?.metadata[key] ?? node?.metadata[camelKey];
  return typeof value === "string" ? value : undefined;
}

export function metadataBoolean(node: GraphNodeDto | undefined, key: string): boolean | undefined {
  const camelKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const value = node?.metadata[key] ?? node?.metadata[camelKey];
  return typeof value === "boolean" ? value : undefined;
}

export function relativePathForNode(node: GraphNodeDto | undefined): string | undefined {
  return (
    metadataString(node, "relative_path") ??
    (node?.kind === "module" && node.subtitle?.endsWith(".py") ? node.subtitle : undefined)
  );
}

export function selectionSummary(node: GraphNodeDto | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  const relativePath = relativePathForNode(node);
  if (node.kind === "module" && relativePath) {
    return relativePath;
  }

  if (isGraphSymbolNodeKind(node.kind)) {
    return metadataString(node, "qualname") ?? node.subtitle ?? undefined;
  }

  return node.subtitle ?? undefined;
}

export function revealActionEnabled(node?: GraphNodeDto): boolean {
  return Boolean(
    node?.availableActions.find((action) => action.actionId === "reveal_source")?.enabled,
  );
}
