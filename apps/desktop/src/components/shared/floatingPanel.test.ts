import { describe, expect, it } from "vitest";
import { clampFloatingPanelPosition } from "./floatingPanel";

describe("clampFloatingPanelPosition", () => {
  it("keeps a floating panel inside its container bounds", () => {
    expect(clampFloatingPanelPosition({
      anchor: { x: 720, y: 420 },
      container: { width: 800, height: 500 },
      margin: 12,
      panel: { width: 260, height: 160 },
    })).toEqual({ x: 528, y: 328 });
  });

  it("keeps the original anchor when dimensions are not measurable yet", () => {
    expect(clampFloatingPanelPosition({
      anchor: { x: 720, y: 420 },
      container: { width: 0, height: 0 },
      panel: { width: 260, height: 160 },
    })).toEqual({ x: 720, y: 420 });
  });

  it("honors the margin when the panel is larger than the available space", () => {
    expect(clampFloatingPanelPosition({
      anchor: { x: -40, y: -20 },
      container: { width: 240, height: 160 },
      margin: 14,
      panel: { width: 400, height: 300 },
    })).toEqual({ x: 14, y: 14 });
  });
});
