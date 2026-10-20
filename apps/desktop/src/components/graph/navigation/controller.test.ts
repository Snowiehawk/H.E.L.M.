import { describe, expect, it } from "vitest";
import { applyNavigation, NavigationController, type WheelSample } from "./controller";
const sample = (change: Partial<WheelSample> = {}): WheelSample => ({
  deltaX: 0,
  deltaY: 100,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  timeStamp: 0,
  ...change,
});
describe("navigation contract sequences (synthetic, no hardware identity)", () => {
  it("normalizes line/page wheels and clamps extreme speed", () => {
    const c = new NavigationController("mouse", false);
    expect(c.wheel(sample({ deltaMode: 1, deltaY: 3 }), 500)).toMatchObject({
      kind: "zoom",
      delta: 0.096,
    });
    expect(c.wheel(sample({ deltaMode: 2, deltaY: 1 }), 500)).toMatchObject({
      kind: "zoom",
      delta: 0.25,
    });
    expect(c.wheel(sample({ deltaY: -1e20 }), 500)).toMatchObject({ kind: "zoom", delta: -0.25 });
  });
  it("retains two-axis pan and its route through momentum magnitude changes", () => {
    const c = new NavigationController("auto", true);
    expect(c.wheel(sample({ deltaX: 2.5, deltaY: 3.2 }), 500)).toEqual({
      kind: "pan",
      x: 2.5,
      y: 3.2,
      ambiguous: true,
    });
    expect(c.wheel(sample({ timeStamp: 30 }), 500).kind).toBe("pan");
    expect(c.wheel(sample({ timeStamp: 200 }), 500).kind).toBe("zoom");
  });
  it("offers explicit fallback for identical ambiguous device streams", () => {
    expect(new NavigationController("mouse", false).wheel(sample({ deltaY: 1 }), 500).kind).toBe(
      "zoom",
    );
    expect(new NavigationController("trackpad", false).wheel(sample(), 500).kind).toBe("pan");
  });
  it.each([true, false])(
    "prioritizes modifier/pinch and suppresses release tails (mac=%s)",
    (mac) => {
      const c = new NavigationController("trackpad", mac);
      expect(c.wheel(sample({ [mac ? "metaKey" : "ctrlKey"]: true }), 500).kind).toBe("zoom");
      expect(c.wheel(sample({ timeStamp: 30 }), 500).kind).toBe("ignore");
      expect(c.wheel(sample({ timeStamp: 210 }), 500).kind).toBe("pan");
      expect(c.wheel(sample({ timeStamp: 220, ctrlKey: true }), 500).kind).toBe("zoom");
    },
  );
  it("ignores malformed, zero and disposed input; reset is instance-local", () => {
    const a = new NavigationController("auto", false),
      b = new NavigationController("trackpad", false);
    for (const event of [
      sample({ deltaY: NaN }),
      sample({ deltaMode: 9 }),
      sample({ deltaY: 0 }),
      sample({ timeStamp: Infinity }),
    ])
      expect(a.wheel(event, 500).kind).toBe("ignore");
    a.wheel(sample(), 500);
    a.reset();
    a.dispose();
    expect(a.wheel(sample(), 500).kind).toBe("ignore");
    expect(b.wheel(sample(), 500).kind).toBe("pan");
  });
  it("zooms around the pointer without independent pan and reverses exactly", () => {
    const view = { x: 30, y: -20, zoom: 0.8 },
      anchor = { x: 300, y: 200 };
    const next = applyNavigation(
      view,
      { kind: "zoom", delta: 0.2, ambiguous: false },
      anchor,
      0.12,
      1.8,
    );
    expect((anchor.x - next.x) / next.zoom).toBeCloseTo((anchor.x - view.x) / view.zoom);
    expect((anchor.y - next.y) / next.zoom).toBeCloseTo((anchor.y - view.y) / view.zoom);
    const reversed = applyNavigation(
      next,
      { kind: "zoom", delta: -0.2, ambiguous: false },
      anchor,
      0.12,
      1.8,
    );
    expect(reversed.x).toBeCloseTo(view.x);
    expect(reversed.zoom).toBeCloseTo(view.zoom);
  });
  it.each([
    [0.12, 1.8],
    [0.001, 1.5],
  ])("bounds zoom to the caller's %s..%s limits", (min, max) => {
    for (const [zoom, delta] of [
      [min, 100],
      [max, -100],
    ]) {
      expect(
        applyNavigation(
          { x: 0, y: 0, zoom },
          { kind: "zoom", delta, ambiguous: false },
          { x: 100, y: 100 },
          min,
          max,
        ),
      ).toEqual({ x: 0, y: 0, zoom });
    }
    expect(
      applyNavigation(
        { x: 1, y: 2, zoom: min },
        { kind: "pan", x: 4, y: -5, ambiguous: false },
        { x: 0, y: 0 },
        min,
        max,
      ),
    ).toEqual({ x: -3, y: 7, zoom: min });
  });
});
