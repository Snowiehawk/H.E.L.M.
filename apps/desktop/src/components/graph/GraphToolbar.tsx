import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type {
  FlowInputDisplayMode,
  GraphAbstractionLevel,
  GraphFilters,
  GraphSettings,
  GraphView,
} from "../../lib/adapter";
import { helpTargetProps } from "../workspace/workspaceHelp";

interface Point {
  x: number;
  y: number;
}

const TOOLBAR_MARGIN = 16;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampPosition(
  next: Point,
  container: HTMLElement,
  toolbar: HTMLElement,
): Point {
  const maxX = Math.max(container.clientWidth - toolbar.offsetWidth - TOOLBAR_MARGIN, TOOLBAR_MARGIN);
  const maxY = Math.max(container.clientHeight - toolbar.offsetHeight - TOOLBAR_MARGIN, TOOLBAR_MARGIN);
  return {
    x: clamp(next.x, TOOLBAR_MARGIN, maxX),
    y: clamp(next.y, TOOLBAR_MARGIN, maxY),
  };
}

export function GraphToolbar({
  graph,
  graphFilters,
  graphSettings,
  flowInputDisplayMode = "param_nodes",
  highlightGraphPath,
  showEdgeLabels,
  canUndoLayout,
  onSelectLevel,
  onDeclutter,
  onFitView,
  onToggleGraphFilter,
  onToggleGraphSetting,
  onSetFlowInputDisplayMode = () => {},
  onToggleGraphPathHighlight,
  onToggleEdgeLabels,
  onUndoLayout,
}: {
  graph?: GraphView;
  graphFilters: GraphFilters;
  graphSettings: GraphSettings;
  flowInputDisplayMode?: FlowInputDisplayMode;
  highlightGraphPath: boolean;
  showEdgeLabels: boolean;
  canUndoLayout: boolean;
  onSelectLevel: (level: GraphAbstractionLevel) => void;
  onDeclutter: () => void;
  onFitView: () => void;
  onToggleGraphFilter: (key: keyof GraphFilters) => void;
  onToggleGraphSetting: (key: keyof GraphSettings) => void;
  onSetFlowInputDisplayMode?: (mode: FlowInputDisplayMode) => void;
  onToggleGraphPathHighlight: () => void;
  onToggleEdgeLabels: () => void;
  onUndoLayout: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState<Point | null>(null);
  const [hasMoved, setHasMoved] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    const container = toolbar?.parentElement;
    if (!toolbar || !(container instanceof HTMLElement)) {
      return;
    }

    if (!hasMoved) {
      const initial = clampPosition(
        {
          x: container.clientWidth - toolbar.offsetWidth - TOOLBAR_MARGIN,
          y: TOOLBAR_MARGIN,
        },
        container,
        toolbar,
      );
      setPosition((current) => {
        if (current && current.x === initial.x && current.y === initial.y) {
          return current;
        }
        return initial;
      });
      return;
    }

    setPosition((current) => {
      if (!current) {
        return current;
      }
      const next = clampPosition(current, container, toolbar);
      if (next.x === current.x && next.y === current.y) {
        return current;
      }
      return next;
    });
  }, [expanded, graph?.targetId, hasMoved, position]);

  if (!graph) {
    return null;
  }

  const availableLevels = graph.focus?.availableLevels ?? [graph.level];
  const showLevelControls = availableLevels.length > 1;
  const showRelationshipFilters = graph.level !== "flow";
  const showFlowInputMode = graph.level === "flow" && graph.flowState?.editable;
  const nodeCountLabel = `${graph.nodes.length} node${graph.nodes.length === 1 ? "" : "s"}`;
  const edgeCountLabel = `${graph.edges.length} edge${graph.edges.length === 1 ? "" : "s"}`;

  const startDragging = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const toolbar = toolbarRef.current;
    const container = toolbar?.parentElement;
    if (!toolbar || !(container instanceof HTMLElement) || position === null) {
      return;
    }

    event.preventDefault();
    const startPosition = position;
    const originX = event.clientX;
    const originY = event.clientY;
    setHasMoved(true);

    const handleMove = (moveEvent: PointerEvent) => {
      const next = clampPosition(
        {
          x: startPosition.x + (moveEvent.clientX - originX),
          y: startPosition.y + (moveEvent.clientY - originY),
        },
        container,
        toolbar,
      );
      setPosition(next);
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  return (
    <div
      ref={toolbarRef}
      className={`graph-toolbar graph-toolbar--floating${expanded ? " is-expanded" : " is-collapsed"}`}
      style={
        position
          ? {
              left: `${position.x}px`,
              top: `${position.y}px`,
            }
          : undefined
      }
    >
      <div className="graph-toolbar__surface">
        <div className="graph-toolbar__compact">
          <button
            {...helpTargetProps("graph.toolbar.drag")}
            aria-label="Move graph controls"
            className="graph-toolbar__drag"
            type="button"
            onPointerDown={startDragging}
          >
            <span />
            <span />
            <span />
          </button>

          <button
            {...helpTargetProps("graph.toolbar.focus", {
              label: graph.focus?.label ?? "Graph",
              kind: graph.level,
            })}
            aria-expanded={expanded}
            className="graph-toolbar__focus"
            type="button"
            onClick={() => setExpanded((current) => !current)}
          >
            <span className="graph-toolbar__focus-copy">
              <span className="graph-toolbar__focus-label">{graph.focus?.label ?? "Graph"}</span>
              <span className="graph-toolbar__focus-meta">{graph.level} view</span>
            </span>
            <span className="graph-toolbar__focus-state">{expanded ? "Hide" : "View"}</span>
          </button>

          <button
            {...helpTargetProps("graph.toolbar.fit-view")}
            className="ghost-button"
            type="button"
            onClick={onFitView}
          >
            Fit view
          </button>
        </div>

        {expanded ? (
          <div className="graph-toolbar__details">
            {showLevelControls ? (
              <section className="graph-toolbar__section">
                <span className="graph-toolbar__section-label">Level</span>
                <div className="graph-toolbar__row graph-levels">
                  {availableLevels.map((level) => (
                    <button
                      key={level}
                      {...helpTargetProps(`graph.level.${level}` as const)}
                      className={`toggle-button${graph.level === level ? " is-active" : ""}`}
                      type="button"
                      onClick={() => onSelectLevel(level)}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {showRelationshipFilters ? (
              <section className="graph-toolbar__section">
                <span className="graph-toolbar__section-label">Relationships</span>
                <div className="graph-toolbar__row graph-filters">
                  <button
                    {...helpTargetProps("graph.filter.calls")}
                    className={`toggle-button${graphFilters.includeCalls ? " is-active" : ""}`}
                    type="button"
                    onClick={() => onToggleGraphFilter("includeCalls")}
                  >
                    Calls
                  </button>
                  <button
                    {...helpTargetProps("graph.filter.imports")}
                    className={`toggle-button${graphFilters.includeImports ? " is-active" : ""}`}
                    type="button"
                    onClick={() => onToggleGraphFilter("includeImports")}
                  >
                    Imports
                  </button>
                  <button
                    {...helpTargetProps("graph.filter.defines")}
                    className={`toggle-button${graphFilters.includeDefines ? " is-active" : ""}`}
                    type="button"
                    onClick={() => onToggleGraphFilter("includeDefines")}
                  >
                    Defines
                  </button>
                </div>
              </section>
            ) : null}

            <section className="graph-toolbar__section">
              <span className="graph-toolbar__section-label">View</span>
              <div className="graph-toolbar__row graph-filters">
                {showRelationshipFilters ? (
                  <button
                    {...helpTargetProps("graph.settings.external-dependencies")}
                    className={`toggle-button${graphSettings.includeExternalDependencies ? " is-active" : ""}`}
                    type="button"
                    onClick={() => onToggleGraphSetting("includeExternalDependencies")}
                  >
                    External
                  </button>
                ) : null}
                {showFlowInputMode ? (
                  <>
                    <button
                      className={`toggle-button${flowInputDisplayMode === "entry" ? " is-active" : ""}`}
                      type="button"
                      onClick={() => onSetFlowInputDisplayMode("entry")}
                    >
                      Entry inputs
                    </button>
                    <button
                      className={`toggle-button${flowInputDisplayMode === "param_nodes" ? " is-active" : ""}`}
                      type="button"
                      onClick={() => onSetFlowInputDisplayMode("param_nodes")}
                    >
                      Parameters
                    </button>
                  </>
                ) : null}
                <button
                  {...helpTargetProps("graph.filter.path")}
                  className={`toggle-button${highlightGraphPath ? " is-active" : ""}`}
                  type="button"
                  onClick={onToggleGraphPathHighlight}
                >
                  Path
                </button>
                <button
                  {...helpTargetProps("graph.filter.labels")}
                  className={`toggle-button${showEdgeLabels ? " is-active" : ""}`}
                  type="button"
                  onClick={onToggleEdgeLabels}
                >
                  Labels
                </button>
              </div>
            </section>

            <section className="graph-toolbar__section">
              <span className="graph-toolbar__section-label">Layout</span>
              <div className="graph-toolbar__row graph-toolbar__layout-row">
                <button
                  {...helpTargetProps("graph.declutter")}
                  className="toggle-button"
                  type="button"
                  onClick={onDeclutter}
                >
                  Declutter
                </button>
                {canUndoLayout ? (
                  <button
                    {...helpTargetProps("graph.undo-layout")}
                    className="ghost-button"
                    type="button"
                    onClick={onUndoLayout}
                  >
                    Undo layout
                  </button>
                ) : null}
              </div>
            </section>

            <div className="graph-toolbar__status" aria-label="Graph summary">
              <span className="graph-toolbar__status-pill">{nodeCountLabel}</span>
              <span className="graph-toolbar__status-pill">{edgeCountLabel}</span>
              {graph.truncated ? (
                <span className="graph-toolbar__status-pill graph-toolbar__status-pill--warning">
                  Trimmed view
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
