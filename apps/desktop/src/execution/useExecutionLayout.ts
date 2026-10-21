import { useEffect, useRef, useState } from "react";

const MAIN_MINIMUM = 640;
const PANE_MINIMUM = 300;
const PANE_MAXIMUM = 640;

/** CSS pixels: keep controls alongside the pane, or put the pane below them. */
export function useExecutionLayout(preferredWidth: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(() => window.innerWidth);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setAvailable(element.getBoundingClientRect().width || window.innerWidth);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const maximumWidth = Math.max(PANE_MINIMUM, Math.min(PANE_MAXIMUM, available - MAIN_MINIMUM));
  return {
    ref,
    stacked: available < MAIN_MINIMUM + PANE_MINIMUM,
    maximumWidth,
    width: Math.max(PANE_MINIMUM, Math.min(maximumWidth, preferredWidth)),
  };
}
