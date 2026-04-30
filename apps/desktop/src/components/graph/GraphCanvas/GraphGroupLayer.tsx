import { ViewportPortal, useReactFlow } from "@xyflow/react";
import { helpTargetProps } from "../../workspace/workspaceHelp";
import type { GroupOrganizeMode } from "../groupOrganizeLayout";
import { GROUP_BOX_PADDING, GROUP_TITLE_OFFSET } from "./constants";
import { organizeOptionsForGroup } from "./layoutHelpers";
import type { GraphCanvasEdge, GraphCanvasNode, GraphGroupBounds } from "./types";
import { isSemanticCanvasNode } from "./types";

export function GraphGroupLayer({
  groupBounds,
  nodes,
  selectedGroupId,
  editingGroupId,
  organizeGroupId,
  editingGroupTitle,
  onChangeEditingGroupTitle,
  onApplyOrganizeMode,
  onFinishGroupTitleEditing,
  onGroupMoveEnd,
  onPreviewGroupMove,
  onSelectGroup,
  onStartEditingGroup,
  onToggleOrganizeGroup,
  onUngroupGroup,
}: {
  groupBounds: GraphGroupBounds[];
  nodes: GraphCanvasNode[];
  selectedGroupId?: string;
  editingGroupId?: string;
  organizeGroupId?: string;
  editingGroupTitle: string;
  onChangeEditingGroupTitle: (title: string) => void;
  onApplyOrganizeMode: (groupId: string, mode: GroupOrganizeMode) => void;
  onFinishGroupTitleEditing: (groupId: string, mode: "save" | "cancel") => void;
  onGroupMoveEnd: () => void;
  onPreviewGroupMove: (
    groupId: string,
    delta: { x: number; y: number },
    basePositions: Map<string, { x: number; y: number }>,
  ) => void;
  onSelectGroup: (groupId: string) => void;
  onStartEditingGroup: (groupId: string) => void;
  onToggleOrganizeGroup: (groupId: string) => void;
  onUngroupGroup: (groupId: string, title: string) => void;
}) {
  const { screenToFlowPosition } = useReactFlow<GraphCanvasNode, GraphCanvasEdge>();
  const beginGroupInteraction = (
    event: {
      button: number;
      clientX: number;
      clientY: number;
      preventDefault: () => void;
      stopPropagation: () => void;
    },
    group: GraphGroupBounds,
  ) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onSelectGroup(group.id);

    const startFlowPosition = screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    const memberNodeIds = new Set(group.memberNodeIds);
    const basePositions = new Map(
      nodes
        .filter((node) => isSemanticCanvasNode(node) && memberNodeIds.has(node.id))
        .map((node) => [node.id, { x: node.position.x, y: node.position.y }] as const),
    );
    let moved = false;

    const handleMove = (moveEvent: PointerEvent) => {
      const currentFlowPosition = screenToFlowPosition({
        x: moveEvent.clientX,
        y: moveEvent.clientY,
      });
      const delta = {
        x: currentFlowPosition.x - startFlowPosition.x,
        y: currentFlowPosition.y - startFlowPosition.y,
      };
      if (delta.x || delta.y) {
        moved = true;
      }
      onPreviewGroupMove(group.id, delta, basePositions);
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      if (moved) {
        onGroupMoveEnd();
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  return (
    <ViewportPortal>
      {groupBounds.map((group) => {
        const nodeCount = group.memberNodeIds.length;
        const nodeCountLabel = `${nodeCount} ${nodeCount === 1 ? "node" : "nodes"} grouped`;

        return (
          <div
            key={group.id}
            data-testid={`graph-group-${group.id}`}
            {...helpTargetProps("graph.group.box", {
              label: group.title,
            })}
            className={`graph-group${selectedGroupId === group.id ? " is-selected" : ""}${editingGroupId === group.id ? " is-editing" : ""}`}
            style={{
              transform: `translate(${group.x}px, ${group.y}px)`,
              width: `${group.width}px`,
              height: `${group.height}px`,
            }}
          >
            <div className="graph-group__frame" />
            <div
              data-testid={`graph-group-hit-area-${group.id}-top`}
              {...helpTargetProps("graph.group.box", {
                label: group.title,
              })}
              aria-hidden="true"
              className="graph-group__hit-area graph-group__hit-area--top"
              onPointerDown={(event) => {
                beginGroupInteraction(event, group);
              }}
            />
            <div
              data-testid={`graph-group-hit-area-${group.id}-right`}
              {...helpTargetProps("graph.group.box", {
                label: group.title,
              })}
              aria-hidden="true"
              className="graph-group__hit-area graph-group__hit-area--right"
              onPointerDown={(event) => {
                beginGroupInteraction(event, group);
              }}
            />
            <div
              data-testid={`graph-group-hit-area-${group.id}-bottom`}
              {...helpTargetProps("graph.group.box", {
                label: group.title,
              })}
              aria-hidden="true"
              className="graph-group__hit-area graph-group__hit-area--bottom"
              onPointerDown={(event) => {
                beginGroupInteraction(event, group);
              }}
            />
            <div
              data-testid={`graph-group-hit-area-${group.id}-left`}
              {...helpTargetProps("graph.group.box", {
                label: group.title,
              })}
              aria-hidden="true"
              className="graph-group__hit-area graph-group__hit-area--left"
              onPointerDown={(event) => {
                beginGroupInteraction(event, group);
              }}
            />
            <div
              {...helpTargetProps("graph.group.box", {
                label: group.title,
              })}
              className="graph-group__title-anchor"
              style={{
                transform: `translate(${GROUP_BOX_PADDING}px, calc(-100% - ${GROUP_TITLE_OFFSET}px))`,
              }}
              onPointerDown={(event) => {
                beginGroupInteraction(event, group);
              }}
            >
              {editingGroupId === group.id ? (
                <input
                  autoFocus
                  className="graph-group__title-input"
                  data-testid={`graph-group-title-input-${group.id}`}
                  value={editingGroupTitle}
                  onBlur={() => onFinishGroupTitleEditing(group.id, "save")}
                  onChange={(event) => onChangeEditingGroupTitle(event.target.value)}
                  onFocus={(event) => {
                    event.currentTarget.select();
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onFinishGroupTitleEditing(group.id, "save");
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onFinishGroupTitleEditing(group.id, "cancel");
                    }
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                />
              ) : (
                <div className="graph-group__header">
                  <div className="graph-group__title-row">
                    <div
                      className="graph-group__title"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onStartEditingGroup(group.id);
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onStartEditingGroup(group.id);
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      {group.title}
                    </div>
                    <div
                      aria-label={nodeCountLabel}
                      className="graph-group__count"
                      title={nodeCountLabel}
                    >
                      {nodeCount}
                    </div>
                    <div className="graph-group__actions">
                      <button
                        {...helpTargetProps("graph.group.organize")}
                        className={`graph-group__action${organizeGroupId === group.id ? " is-active" : ""}`}
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onToggleOrganizeGroup(group.id);
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        Organize
                      </button>
                      <button
                        className="graph-group__action graph-group__action--ungroup"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onUngroupGroup(group.id, group.title);
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        Ungroup
                      </button>
                    </div>
                  </div>
                  {organizeGroupId === group.id ? (
                    <div
                      className="graph-group__organize-row"
                      data-testid={`graph-group-organize-${group.id}`}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      {organizeOptionsForGroup(group, nodes).map((option) => (
                        <button
                          key={option.mode}
                          {...helpTargetProps("graph.group.organize", {
                            label: option.label,
                          })}
                          className="graph-group__mode"
                          data-testid={`graph-group-organize-${group.id}-${option.mode}`}
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onApplyOrganizeMode(group.id, option.mode);
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
