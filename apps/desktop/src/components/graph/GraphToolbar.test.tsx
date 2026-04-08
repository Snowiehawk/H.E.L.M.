import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphView } from "../../lib/adapter";
import { GraphToolbar } from "./GraphToolbar";

const baseGraph: GraphView = {
  rootNodeId: "repo:/workspace/project",
  targetId: "module:helm.ui.graph",
  level: "module",
  nodes: [],
  edges: [],
  breadcrumbs: [
    {
      nodeId: "repo:/workspace/project",
      level: "repo",
      label: "project",
    },
  ],
  focus: {
    targetId: "module:helm.ui.graph",
    level: "module",
    label: "helm.ui.graph",
    availableLevels: ["repo", "module", "symbol"],
  },
  truncated: false,
};

describe("GraphToolbar", () => {
  it("renders settings controls and forwards clicks", async () => {
    const user = userEvent.setup();
    const onToggleGraphSetting = vi.fn();

    render(
      <div>
        <GraphToolbar
          graph={baseGraph}
          graphFilters={{
            includeCalls: true,
            includeDefines: true,
            includeImports: true,
          }}
          graphSettings={{
            includeExternalDependencies: false,
          }}
          highlightGraphPath={false}
          showEdgeLabels={false}
          inspectorOpen={false}
          onSelectBreadcrumb={vi.fn()}
          onSelectLevel={vi.fn()}
          onToggleGraphFilter={vi.fn()}
          onToggleGraphSetting={onToggleGraphSetting}
          onToggleGraphPathHighlight={vi.fn()}
          onToggleEdgeLabels={vi.fn()}
          onToggleInspector={vi.fn()}
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Controls" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      screen.getByRole("button", { name: /Show external dependencies/i }),
    );

    expect(onToggleGraphSetting).toHaveBeenCalledWith("includeExternalDependencies");
  });
});
