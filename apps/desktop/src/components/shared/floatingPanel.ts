import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

export interface FloatingPanelAnchor {
  x: number;
  y: number;
}

export interface FloatingPanelBounds {
  width: number;
  height: number;
}

export interface FloatingPanelPlacementOptions {
  margin?: number;
}

const DEFAULT_FLOATING_PANEL_MARGIN = 12;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function clampFloatingPanelPosition({
  anchor,
  container,
  margin = DEFAULT_FLOATING_PANEL_MARGIN,
  panel,
}: {
  anchor: FloatingPanelAnchor;
  container: FloatingPanelBounds;
  margin?: number;
  panel: FloatingPanelBounds;
}): FloatingPanelAnchor {
  if (
    container.width <= 0
    || container.height <= 0
    || panel.width <= 0
    || panel.height <= 0
  ) {
    return anchor;
  }

  const maxX = Math.max(margin, container.width - panel.width - margin);
  const maxY = Math.max(margin, container.height - panel.height - margin);
  return {
    x: clamp(anchor.x, margin, maxX),
    y: clamp(anchor.y, margin, maxY),
  };
}

function elementBounds(element: HTMLElement): FloatingPanelBounds {
  const rect = element.getBoundingClientRect();
  return {
    width: element.clientWidth || element.offsetWidth || rect.width,
    height: element.clientHeight || element.offsetHeight || rect.height,
  };
}

function panelBounds(element: HTMLElement): FloatingPanelBounds {
  const rect = element.getBoundingClientRect();
  return {
    width: element.offsetWidth || rect.width,
    height: element.offsetHeight || rect.height,
  };
}

function offsetParentElement(element: HTMLElement): HTMLElement | null {
  const offsetParent = element.offsetParent;
  if (offsetParent instanceof HTMLElement) {
    return offsetParent;
  }
  return element.parentElement instanceof HTMLElement ? element.parentElement : null;
}

export function useClampedFloatingPanel(
  anchor: FloatingPanelAnchor,
  options: FloatingPanelPlacementOptions = {},
): {
  ref: RefObject<HTMLDivElement>;
  style: CSSProperties;
} {
  const margin = options.margin ?? DEFAULT_FLOATING_PANEL_MARGIN;
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<FloatingPanelAnchor>(anchor);

  const updatePosition = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) {
      setPosition((current) => (
        current.x === anchor.x && current.y === anchor.y ? current : anchor
      ));
      return;
    }

    const container = offsetParentElement(panel);
    const next = container
      ? clampFloatingPanelPosition({
          anchor,
          container: elementBounds(container),
          margin,
          panel: panelBounds(panel),
        })
      : anchor;

    setPosition((current) => (
      current.x === next.x && current.y === next.y ? current : next
    ));
  }, [anchor, margin]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return undefined;
    }

    const container = offsetParentElement(panel);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(updatePosition);
    resizeObserver?.observe(panel);
    if (container) {
      resizeObserver?.observe(container);
    }
    window.addEventListener("resize", updatePosition);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, [updatePosition]);

  return {
    ref: panelRef,
    style: {
      left: `${position.x}px`,
      top: `${position.y}px`,
    },
  };
}
