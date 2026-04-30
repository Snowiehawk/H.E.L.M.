import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useKeyPress } from "@xyflow/react";

export function useExpressionPanMode() {
  const panModeActive = useKeyPress("Space");
  const [pointerInsidePanel, setPointerInsidePanel] = useState(false);
  const [panPointerDragging, setPanPointerDragging] = useState(false);

  useEffect(() => {
    const handlePointerUp = () => {
      setPanPointerDragging(false);
    };

    window.addEventListener("pointerup", handlePointerUp, true);
    return () => window.removeEventListener("pointerup", handlePointerUp, true);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const showPanCursor = panModeActive && (pointerInsidePanel || panPointerDragging);
    document.body.classList.toggle("graph-pan-cursor-active", showPanCursor && !panPointerDragging);
    document.body.classList.toggle(
      "graph-pan-cursor-dragging",
      showPanCursor && panPointerDragging,
    );

    return () => {
      document.body.classList.remove("graph-pan-cursor-active");
      document.body.classList.remove("graph-pan-cursor-dragging");
    };
  }, [panModeActive, panPointerDragging, pointerInsidePanel]);

  return {
    panModeActive,
    handlePointerOver: () => {
      setPointerInsidePanel(true);
    },
    handlePointerOut: (event: ReactPointerEvent<HTMLElement>) => {
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof globalThis.Node) || !event.currentTarget.contains(nextTarget)) {
        setPointerInsidePanel(false);
      }
    },
    handlePointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      setPointerInsidePanel(true);
      if (panModeActive && event.button === 0) {
        setPanPointerDragging(true);
      }
    },
  };
}
