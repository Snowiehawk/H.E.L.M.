import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type PropsWithChildren,
} from "react";
import { StatusPill } from "../shared/StatusPill";
import {
  helpTargetProps,
  type HelpDescriptorId,
} from "./workspaceHelp";

export type BlueprintInspectorDrawerMode = "collapsed" | "expanded";
export type BlueprintInspectorDrawerTone = "default" | "accent" | "warning";
export interface BlueprintInspectorDrawerAction {
  id: string;
  label: string;
  helpId: HelpDescriptorId;
  onClick: () => void;
  tone?: "ghost" | "secondary";
}

export const BLUEPRINT_INSPECTOR_COLLAPSED_HEIGHT = 60;
export const DEFAULT_BLUEPRINT_INSPECTOR_DRAWER_HEIGHT = 360;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function clampBlueprintInspectorDrawerHeight(
  nextHeight: number,
  containerHeight: number,
  narrowLayout: boolean,
) {
  const safeContainerHeight = Math.max(containerHeight || 0, 360);
  const minHeight = narrowLayout ? 220 : 280;
  const maxHeight = Math.max(
    minHeight,
    Math.min(
      Math.floor(safeContainerHeight * (narrowLayout ? 0.72 : 0.62)),
      safeContainerHeight - (narrowLayout ? 92 : 120),
    ),
  );
  return clamp(nextHeight, minHeight, maxHeight);
}

export function BlueprintInspectorDrawer({
  actionError,
  actions,
  children,
  drawerHeight,
  mode,
  showDismiss,
  statusLabel,
  subtitle,
  statusTone = "default",
  title,
  onClose,
  onCollapse,
  onExpand,
  onHeightChange,
}: PropsWithChildren<{
  actionError?: string | null;
  actions?: BlueprintInspectorDrawerAction[];
  drawerHeight: number;
  mode: BlueprintInspectorDrawerMode;
  showDismiss?: boolean;
  statusLabel: string;
  subtitle: string;
  statusTone?: BlueprintInspectorDrawerTone;
  title: string;
  onClose: () => void;
  onCollapse: () => void;
  onExpand: () => void;
  onHeightChange: (nextHeight: number) => void;
}>) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const suppressToggleClickRef = useRef(false);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const parent = drawerRef.current?.parentElement;
    if (!(parent instanceof HTMLElement)) {
      return;
    }

    const updateSize = () => {
      setContainerSize({
        width: parent.clientWidth,
        height: parent.clientHeight,
      });
    };

    updateSize();

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        updateSize();
      });
      observer.observe(parent);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  const narrowLayout = useMemo(() => {
    if (containerSize.width > 0) {
      return containerSize.width < 920;
    }
    return typeof window !== "undefined" ? window.innerWidth < 920 : false;
  }, [containerSize.width]);

  const clampedHeight = useMemo(
    () => clampBlueprintInspectorDrawerHeight(drawerHeight, containerSize.height || 640, narrowLayout),
    [containerSize.height, drawerHeight, narrowLayout],
  );

  useEffect(() => {
    if (mode === "expanded" && clampedHeight !== drawerHeight) {
      onHeightChange(clampedHeight);
    }
  }, [clampedHeight, drawerHeight, mode, onHeightChange]);

  const handleExpandedRailPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const startY = event.clientY;
    const startHeight = clampedHeight;
    let moved = false;

    event.preventDefault();

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = startY - moveEvent.clientY;
      if (Math.abs(delta) > 3) {
        moved = true;
        suppressToggleClickRef.current = true;
      }
      onHeightChange(
        clampBlueprintInspectorDrawerHeight(
          startHeight + delta,
          containerSize.height || 640,
          narrowLayout,
        ),
      );
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);

      if (moved) {
        window.setTimeout(() => {
          suppressToggleClickRef.current = false;
        }, 0);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const handleExpandedRailClick = () => {
    if (suppressToggleClickRef.current) {
      return;
    }
    onCollapse();
  };

  const drawerActions = actions ?? [];
  const drawerHeightStyle =
    mode === "expanded"
      ? { height: `${clampedHeight}px` }
      : { minHeight: `${BLUEPRINT_INSPECTOR_COLLAPSED_HEIGHT}px` };

  return (
    <section
      ref={drawerRef}
      aria-label="Inspector drawer"
      className={`blueprint-inspector-drawer blueprint-inspector-drawer--${mode}`}
      data-mode={mode}
      data-testid="blueprint-inspector-drawer"
      style={drawerHeightStyle}
    >
      {mode === "collapsed" ? (
        <div className="blueprint-inspector-drawer__peek">
          <button
            {...helpTargetProps("inspector.toggle", { label: title })}
            aria-label={`Expand inspector for ${title}`}
            className="blueprint-inspector-drawer__peek-main"
            data-testid="blueprint-inspector-drawer-toggle"
            type="button"
            onClick={onExpand}
          >
            <span aria-hidden="true" className="blueprint-inspector-drawer__grip">
              <span />
              <span />
            </span>
            <div className="blueprint-inspector-drawer__summary">
              <strong>{title}</strong>
              <span>{subtitle}</span>
            </div>
            <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
          </button>

          {drawerActions.length ? (
            <div className="blueprint-inspector-drawer__actions">
              {drawerActions.map((action) => (
                <button
                  key={action.id}
                  {...helpTargetProps(action.helpId)}
                  className={`${action.tone === "secondary" ? "secondary-button" : "ghost-button"} blueprint-inspector-drawer__action`}
                  type="button"
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}

          {showDismiss ? (
            <button
              {...helpTargetProps("inspector.close")}
              aria-label="Dismiss inspector target"
              className="ghost-button blueprint-inspector-drawer__peek-close"
              data-testid="blueprint-inspector-drawer-close"
              type="button"
              onClick={onClose}
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : (
        <div className="blueprint-inspector-drawer__rail">
          <button
            {...helpTargetProps("inspector.resize", { label: title })}
            aria-label={`Collapse inspector for ${title}`}
            className="blueprint-inspector-drawer__rail-button"
            data-testid="blueprint-inspector-drawer-toggle"
            type="button"
            onClick={handleExpandedRailClick}
            onPointerDown={handleExpandedRailPointerDown}
          >
            <span aria-hidden="true" className="blueprint-inspector-drawer__grip">
              <span />
              <span />
            </span>
            <div className="blueprint-inspector-drawer__summary">
              <strong>{title}</strong>
              <span>{subtitle}</span>
            </div>
            <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
          </button>

          {drawerActions.length ? (
            <div className="blueprint-inspector-drawer__actions blueprint-inspector-drawer__actions--expanded">
              {drawerActions.map((action) => (
                <button
                  key={action.id}
                  {...helpTargetProps(action.helpId)}
                  className={`${action.tone === "secondary" ? "secondary-button" : "ghost-button"} blueprint-inspector-drawer__action`}
                  type="button"
                  onClick={action.onClick}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {actionError ? <p className="error-copy blueprint-inspector-drawer__error">{actionError}</p> : null}

      <div
        className={`blueprint-inspector-drawer__body${mode === "collapsed" ? " blueprint-inspector-drawer__body--hidden" : ""}`}
        hidden={mode === "collapsed"}
      >
        {children}
      </div>
    </section>
  );
}
