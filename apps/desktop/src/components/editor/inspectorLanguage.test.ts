import { describe, expect, it } from "vitest";
import { inferInspectorLanguage, normalizeMonacoLanguage } from "./inspectorLanguage";

describe("inspectorLanguage", () => {
  it("prefers editable source paths when available", () => {
    expect(
      inferInspectorLanguage({
        editablePath: "src/helm/ui/api.py",
        selectedRelativePath: "src/helm/ui/api.ts",
        symbolFilePath: "src/helm/ui/api.js",
        metadata: { language: "json" },
      }),
    ).toBe("python");
  });

  it("falls back through selected path, symbol path, metadata, then plaintext", () => {
    expect(
      inferInspectorLanguage({
        selectedRelativePath: "src/app/view.tsx",
      }),
    ).toBe("typescript");

    expect(
      inferInspectorLanguage({
        symbolFilePath: "src/app/view.jsx",
      }),
    ).toBe("javascript");

    expect(
      inferInspectorLanguage({
        metadata: { language: "py" },
      }),
    ).toBe("python");

    expect(
      inferInspectorLanguage({
        metadata: { language: "unknown-language" },
      }),
    ).toBe("unknown-language");

    expect(inferInspectorLanguage({})).toBe("plaintext");
  });

  it("normalizes language aliases", () => {
    expect(normalizeMonacoLanguage(" text ")).toBe("plaintext");
    expect(normalizeMonacoLanguage("ts")).toBe("typescript");
    expect(normalizeMonacoLanguage("jsx")).toBe("javascript");
    expect(normalizeMonacoLanguage("yml")).toBe("yaml");
  });
});
