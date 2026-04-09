import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type {
  GraphAbstractionLevel,
  GraphBreadcrumbDto,
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

function isNativeMacApp() {
  return (
    typeof window !== "undefined"
    && "__TAURI_INTERNALS__" in window
    && typeof navigator !== "undefined"
    && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
  );
}

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
  highlightGraphPath,
  showEdgeLabels,
  inspectorOpen,
  canUndoDeclutter,
  onSelectBreadcrumb,
  onSelectLevel,
  onDeclutter,
  onToggleGraphFilter,
  onToggleGraphSetting,
  onToggleGraphPathHighlight,
  onToggleEdgeLabels,
  onToggleInspector,
  onUndoDeclutter,
}: {
  graph?: GraphView;
  graphFilters: GraphFilters;
  graphSettings: GraphSettings;
  highlightGraphPath: boolean;
  showEdgeLabels: boolean;
  inspectorOpen: boolean;
  canUndoDeclutter: boolean;
  onSelectBreadcrumb: (breadcrumb: GraphBreadcrumbDto) => void;
  onSelectLevel: (level: GraphAbstractionLevel) => void;
  onDeclutter: () => void;
  onToggleGraphFilter: (key: keyof GraphFilters) => void;
  onToggleGraphSetting: (key: keyof GraphSettings) => void;
  onToggleGraphPathHighlight: () => void;
  onToggleEdgeLabels: () => void;
  onToggleInspector: () => void;
  onUndoDeclutter: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  useEffect(() => {
    setSettingsOpen(false);
  }, [graph?.targetId]);

  useEffect(() => {
    if (!expanded) {
      setSettingsOpen(false);
    }
  }, [expanded]);

  if (!graph) {
    return null;
  }

  const showInlineViewOptions = !isNativeMacApp();

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
            className="graph-toolbar__focus"
            type="button"
            onClick={() => setExpanded((current) => !current)}
          >
            <span className="graph-toolbar__focus-label">{graph.focus?.label ?? "Graph"}</span>
            <span className="graph-toolbar__focus-meta">{graph.level}</span>
          </button>

          <button
            {...helpTargetProps("graph.toolbar.inspector")}
            className={`toggle-button${inspectorOpen ? " is-active" : ""}`}
            type="button"
            onClick={onToggleInspector}
          >
            Inspector
          </button>

          <button
            {...helpTargetProps("graph.toolbar.controls")}
            className={`toggle-button${expanded ? " is-active" : ""}`}
            type="button"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Collapse" : "Controls"}
          </button>
        </div>

        {expanded ? (
          <div className="graph-toolbar__details">
            <div className="graph-toolbar__row graph-levels">
              {(graph.focus?.availableLevels ?? [graph.level]).map((level) => (
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

            {showInlineViewOptions ? (
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
            ) : null}

            <div className="graph-breadcrumbs graph-breadcrumbs--toolbar">
              {graph.breadcrumbs.map((breadcrumb) => (
                <button
                  key={`${breadcrumb.level}:${breadcrumb.nodeId}`}
                  {...helpTargetProps("graph.toolbar.breadcrumb", { label: breadcrumb.label })}
                  className="graph-breadcrumb"
                  type="button"
                  onClick={() => onSelectBreadcrumb(breadcrumb)}
                >
                  <span>{breadcrumb.level}</span>
                  <strong>{breadcrumb.label}</strong>
                </button>
              ))}
            </div>

            <div className="graph-toolbar__row graph-toolbar__settings-row">
              <button
                {...helpTargetProps("graph.declutter")}
                className="toggle-button"
                type="button"
                onClick={onDeclutter}
              >
                Declutter
              </button>
              {canUndoDeclutter ? (
                <button
                  {...helpTargetProps("graph.undo-declutter")}
                  className="ghost-button"
                  type="button"
                  onClick={onUndoDeclutter}
                >
                  Undo declutter
                </button>
              ) : null}
              <button
                {...helpTargetProps("graph.toolbar.settings")}
                className={`toggle-button${settingsOpen ? " is-active" : ""}`}
                type="button"
                onClick={() => setSettingsOpen((current) => !current)}
              >
                Settings
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {settingsOpen ? (
        <aside className="graph-settings-drawer">
          <div className="graph-settings-drawer__header">
            <div className="graph-settings-drawer__copy">
              <h3>Graph settings</h3>
              <p>Advanced visibility controls stay here so the main graph tools stay simple.</p>
            </div>
            <button
              aria-label="Close graph settings"
              className="graph-settings-drawer__close"
              type="button"
              onClick={() => setSettingsOpen(false)}
            >
              Close
            </button>
          </div>

          <label className="graph-settings-toggle">
            <div className="graph-settings-toggle__copy">
              <strong>Show external dependencies</strong>
              <span>Reveal dependency nodes and edges outside the authored repo boundary.</span>
            </div>
            <button
              {...helpTargetProps("graph.settings.external-dependencies")}
              aria-pressed={graphSettings.includeExternalDependencies}
              className={`toggle-button${graphSettings.includeExternalDependencies ? " is-active" : ""}`}
              type="button"
              onClick={() => onToggleGraphSetting("includeExternalDependencies")}
            >
              {graphSettings.includeExternalDependencies ? "On" : "Off"}
            </button>
          </label>
        </aside>
      ) : null}
    </div>
  );
}
