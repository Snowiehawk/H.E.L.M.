import { useEffect, useRef, useState } from "react";
import { Panel, useReactFlow } from "@xyflow/react";
import {
  applyNavigation,
  BURST_GAP_MS,
  NavigationController,
  type NavigationMode,
} from "./controller";

// Disable all library wheel/pinch paths: this controller is the sole gesture owner.
export const navigationProps = {
  zoomOnScroll: false,
  panOnScroll: false,
  zoomOnPinch: false,
  zoomActivationKeyCode: null,
} as const;

type GestureEvent = Event & { scale: number; clientX: number; clientY: number };
export function GraphNavigation({
  active,
  minZoom,
  maxZoom,
}: {
  active: boolean;
  minZoom: number;
  maxZoom: number;
}) {
  const marker = useRef<HTMLLabelElement>(null);
  const flow = useReactFlow();
  const [mode, setMode] = useState<NavigationMode>("auto");
  useEffect(() => {
    const surface = marker.current?.closest<HTMLElement>(".react-flow");
    if (!surface || !active) return;
    const controller = new NavigationController(mode, /Mac|iPhone|iPad/.test(navigator.platform));
    let gestureScale = 1;
    let gestureActive = false;
    let gestureEnd = -Infinity;
    const owns = (event: Event) =>
      event.target instanceof Element &&
      !event.target.closest(
        "input,textarea,select,button,[contenteditable=true],.nowheel,.react-flow__panel",
      ) &&
      !surface.closest("[hidden]") &&
      document.visibilityState !== "hidden";
    const move = (event: { clientX: number; clientY: number }, delta: number) => {
      const rect = surface.getBoundingClientRect();
      void flow.setViewport(
        applyNavigation(
          flow.getViewport(),
          { kind: "zoom", delta, ambiguous: false },
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          minZoom,
          maxZoom,
        ),
      );
    };
    const wheel = (event: WheelEvent) => {
      if (!owns(event) || !event.cancelable) return;
      event.preventDefault();
      event.stopPropagation();
      if (gestureActive || event.timeStamp - gestureEnd < BURST_GAP_MS) return;
      const rect = surface.getBoundingClientRect();
      const intent = controller.wheel(event, rect.height);
      if (intent.kind !== "ignore")
        void flow.setViewport(
          applyNavigation(
            flow.getViewport(),
            intent,
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            minZoom,
            maxZoom,
          ),
        );
    };
    const gestureStart = (event: Event) => {
      if (!owns(event)) return;
      event.preventDefault();
      event.stopPropagation();
      gestureActive = true;
      gestureScale = 1;
      controller.reset();
    };
    const gestureChange = (event: Event) => {
      if (!gestureActive || !owns(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const gesture = event as GestureEvent;
      if (Number.isFinite(gesture.scale) && gesture.scale > 0) {
        move(gesture, -Math.log(gesture.scale / gestureScale));
        gestureScale = gesture.scale;
      }
    };
    const gestureStop = (event: Event) => {
      if (!gestureActive) return;
      event.preventDefault();
      event.stopPropagation();
      gestureActive = false;
      gestureEnd = event.timeStamp;
      controller.reset();
    };
    const reset = () => {
      controller.reset();
      gestureActive = false;
      gestureEnd = -Infinity;
    };
    surface.addEventListener("wheel", wheel, { passive: false, capture: true });
    surface.addEventListener("gesturestart", gestureStart, { passive: false, capture: true });
    surface.addEventListener("gesturechange", gestureChange, { passive: false, capture: true });
    surface.addEventListener("gestureend", gestureStop, { passive: false, capture: true });
    surface.addEventListener("pointerleave", reset);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", reset);
    return () => {
      controller.dispose();
      surface.removeEventListener("wheel", wheel, true);
      surface.removeEventListener("gesturestart", gestureStart, true);
      surface.removeEventListener("gesturechange", gestureChange, true);
      surface.removeEventListener("gestureend", gestureStop, true);
      surface.removeEventListener("pointerleave", reset);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", reset);
    };
  }, [active, flow, mode, minZoom, maxZoom]);
  return (
    <Panel position="top-right">
      <label ref={marker} className="graph-navigation-input">
        Navigation input{" "}
        <select
          aria-label="Navigation input"
          value={mode}
          title="Auto uses event hints. Choose Mouse wheel or Trackpad when hardware events are ambiguous. Command (Mac) / Ctrl (Windows) + scroll zooms."
          onChange={(event) => setMode(event.target.value as NavigationMode)}
        >
          <option value="auto">Auto (event hints)</option>
          <option value="mouse">Mouse wheel</option>
          <option value="trackpad">Trackpad</option>
        </select>
      </label>
    </Panel>
  );
}
