export type NavigationMode = "auto" | "mouse" | "trackpad";
export type Viewport = { x: number; y: number; zoom: number };
export type WheelSample = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  timeStamp: number;
};
export type NavigationIntent =
  | { kind: "pan"; x: number; y: number; ambiguous: boolean }
  | { kind: "zoom"; delta: number; ambiguous: boolean }
  | { kind: "ignore"; ambiguous: false };
const ignore: NavigationIntent = { kind: "ignore", ambiguous: false };
export const BURST_GAP_MS = 160;
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/** WheelEvent has no reliable hardware identity. Auto is a bounded heuristic. */
export class NavigationController {
  private lastTime = -Infinity;
  private route?: "pan" | "zoom";
  private modified = false;
  private disposed = false;
  constructor(
    private mode: NavigationMode,
    private mac: boolean,
  ) {}
  reset() {
    this.lastTime = -Infinity;
    this.route = undefined;
    this.modified = false;
  }
  dispose() {
    this.reset();
    this.disposed = true;
  }
  wheel(event: WheelSample, pageHeight: number): NavigationIntent {
    if (
      this.disposed ||
      ![event.deltaX, event.deltaY, event.timeStamp, pageHeight].every(Number.isFinite) ||
      ![0, 1, 2].includes(event.deltaMode) ||
      pageHeight <= 0
    )
      return ignore;
    const gap = event.timeStamp - this.lastTime;
    if (gap < 0 || gap > BURST_GAP_MS) this.reset();
    const unit =
      event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.min(pageHeight, 1000) : 1;
    const x = clamp(event.deltaX * unit, 240);
    const y = clamp(event.deltaY * unit, 240);
    if (x === 0 && y === 0) return ignore;
    const modifier = this.mac ? event.metaKey : event.ctrlKey;
    // Ctrl-wheel also carries synthesized pinch on WebKit/Chromium. One route handles both.
    const zoomGesture = event.ctrlKey || modifier;
    this.lastTime = event.timeStamp;
    if (zoomGesture) {
      this.modified = true;
      return {
        kind: "zoom",
        delta: clamp(y * (event.ctrlKey && !modifier ? 0.01 : 0.002), 0.25),
        ambiguous: false,
      };
    }
    // Ignore an unmodified inertia tail after zoom until the burst has ended.
    if (this.modified) return ignore;
    this.route ??=
      this.mode === "mouse"
        ? "zoom"
        : this.mode === "trackpad"
          ? "pan"
          : event.deltaMode !== 0 ||
              (event.deltaX === 0 && Math.abs(event.deltaY) >= 40 && Number.isInteger(event.deltaY))
            ? "zoom"
            : "pan";
    return this.route === "pan"
      ? { kind: "pan", x, y, ambiguous: this.mode === "auto" }
      : { kind: "zoom", delta: clamp(y * 0.002, 0.25), ambiguous: this.mode === "auto" };
  }
}

/** Positive delta zooms out. Translation is only the pointer anchor calculation. */
export function applyNavigation(
  viewport: Viewport,
  intent: NavigationIntent,
  anchor: { x: number; y: number },
  minZoom: number,
  maxZoom: number,
): Viewport {
  if (
    !Object.values(viewport).every(Number.isFinite) ||
    viewport.zoom <= 0 ||
    !Object.values(anchor).every(Number.isFinite) ||
    !Number.isFinite(minZoom) ||
    !Number.isFinite(maxZoom) ||
    minZoom <= 0 ||
    maxZoom < minZoom
  )
    return viewport;
  if (intent.kind === "ignore") return viewport;
  if (intent.kind === "pan")
    return { ...viewport, x: viewport.x - intent.x, y: viewport.y - intent.y };
  const zoom = Math.max(
    minZoom,
    Math.min(maxZoom, viewport.zoom * Math.exp(-clamp(intent.delta, 0.25))),
  );
  const ratio = zoom / viewport.zoom;
  return {
    x: anchor.x - (anchor.x - viewport.x) * ratio,
    y: anchor.y - (anchor.y - viewport.y) * ratio,
    zoom,
  };
}
