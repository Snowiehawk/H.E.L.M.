import css from "../styles/index.css?raw";
import { describe, expect, it } from "vitest";
import { issueState } from "./issueState";

const variables = (block: string) =>
  Object.fromEntries([...block.matchAll(/--([\w-]+): (#[\da-f]+);/g)].map((m) => [m[1], m[2]]));
function luminance(hex: string) {
  const rgb = hex
    .slice(1)
    .match(/../g)!
    .map((value) => parseInt(value, 16) / 255);
  const linear = rgb.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}
function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("issue-only binary presentation", () => {
  it("does not infer workflow progress or coerce unavailable state", () => {
    expect(issueState("OPEN")).toEqual({ kind: "open", label: "Open" });
    expect(issueState("CLOSED")).toEqual({ kind: "closed", label: "Closed" });
    for (const invalid of [undefined, null, "open", "TODO", "IN_PROGRESS", "COMPLETED"])
      expect(issueState(invalid)).toEqual({ kind: "unavailable", label: "State unavailable" });
  });

  it.each(["light", "dark"])("keeps actual %s theme text and essential cues readable", (theme) => {
    const base = variables(css.match(/:root \{([^}]+)}/)![1]);
    const issue = variables(css.match(/\.issue-graph-panel \{([^}]+)}/)![1]);
    if (theme === "dark") {
      Object.assign(base, variables(css.match(/:root\[data-theme="dark"\] \{([^}]+)}/)![1]));
      Object.assign(
        issue,
        variables(css.match(/:root\[data-theme="dark"\] \.issue-graph-panel \{([^}]+)}/)![1]),
      );
    }
    for (const state of ["open", "closed"]) {
      const background = issue[`issue-${state}-surface`];
      const indicator = issue[`issue-${state}-state`];
      for (const text of [base.text, base["text-muted"], indicator])
        expect(contrast(text, background), `${theme} ${state} text ${text}`).toBeGreaterThanOrEqual(
          4.5,
        );
      expect(contrast(indicator, base["surface-solid"]), "legend text").toBeGreaterThanOrEqual(4.5);
      expect(contrast(indicator, background), "state stripe").toBeGreaterThanOrEqual(3);
      expect(
        contrast(base["accent-strong"], background),
        "selection border",
      ).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(base["accent-strong"], base.bg), "keyboard focus").toBeGreaterThanOrEqual(3);
  });
});
