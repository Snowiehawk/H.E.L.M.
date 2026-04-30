import { describe, expect, it } from "vitest";
import { createMockWorkspaceState } from "../../mocks/mockData";
import { normalizeMockWorkspacePath } from "./paths";
import {
  buildMockWorkspaceFileTree,
  mockWorkspaceAffectedPaths,
  readMockWorkspaceFile,
} from "./workspaceFiles";

describe("mock desktop workspace file helpers", () => {
  it("normalizes repo-relative workspace paths without allowing escapes", () => {
    expect(normalizeMockWorkspacePath("\\src\\helm\\ui\\api.py")).toBe("src/helm/ui/api.py");
    expect(() => normalizeMockWorkspacePath("../outside.py")).toThrow(
      "Repo-relative paths must stay inside the workspace.",
    );
  });

  it("builds tree entries and reads seeded plus created workspace files", () => {
    const state = createMockWorkspaceState();
    state.workspaceFiles["notes/design.md"] = {
      kind: "file",
      content: "# Design\n",
    };
    state.workspaceFiles.scratch = { kind: "directory" };

    const tree = buildMockWorkspaceFileTree("/repo", state);
    const paths = tree.entries.map((entry) => entry.relativePath);

    expect(paths).toContain("src/helm/ui");
    expect(paths).toContain("notes");
    expect(paths).toContain("notes/design.md");
    expect(paths).toContain("scratch");
    expect(readMockWorkspaceFile(state, "notes/design.md").content).toBe("# Design\n");
    expect(readMockWorkspaceFile(state, "src/helm/ui/api.py").content).toContain(
      "build_graph_summary",
    );
    expect(mockWorkspaceAffectedPaths(state, "notes")).toEqual(["notes", "notes/design.md"]);
  });
});
