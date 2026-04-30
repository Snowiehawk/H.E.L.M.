import type { GroupOrganizeMode } from "../groupOrganizeLayout";

export const REROUTE_NODE_PREFIX = "reroute:";
export const REROUTE_NODE_SIZE = 18;
export const GROUP_BOX_PADDING = 24;
export const GROUP_TITLE_OFFSET = 12;
export const DEFAULT_GROUP_TITLE = "Group";
export const FALLBACK_GROUP_NODE_WIDTH = 252;
export const FALLBACK_GROUP_NODE_HEIGHT = 96;
export const EMPTY_STRING_SET = new Set<string>();
export const GROUP_ORGANIZE_OPTIONS: Array<{ mode: GroupOrganizeMode; label: string }> = [
  { mode: "column", label: "Column" },
  { mode: "row", label: "Row" },
  { mode: "grid", label: "Grid" },
  { mode: "tidy", label: "Tidy" },
  { mode: "kind", label: "By kind" },
];
export const MIN_GRAPH_ZOOM = 0.12;
export const MAX_GRAPH_ZOOM = 1.8;
export const FLOW_CONNECTION_RADIUS = 32;
export const FLOW_RECONNECT_RADIUS = 16;
