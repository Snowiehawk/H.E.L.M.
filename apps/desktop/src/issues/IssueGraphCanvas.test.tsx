import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getViewportForBounds } from "@xyflow/react";
import { IssueGraphCanvas } from "./IssueGraphCanvas";
import type { IssueGraph } from "./issueGraph";

const flow = vi.hoisted(() => ({ fitView: vi.fn(), latest: {} as any }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ReactFlow: (props: any) => {
      flow.latest = props;
      useEffect(() => {
        props.onInit(flow);
      }, []);
      return (
        <div>
          {props.nodes.map((node: any) => (
            <button key={node.id} onClick={() => props.onNodeClick({}, node)}>
              {node.data.issue.title}
            </button>
          ))}
        </div>
      );
    },
    Controls: () => null,
    Background: () => null,
  };
});

const graph: IssueGraph = {
  namespace: "github-issues|native-repo|overview",
  partial: false,
  nodes: [
    {
      id: "github-issue:native-1",
      nativeId: "native-1",
      number: 1,
      title: "Synthetic node",
      repository: "example/repo",
      state: "OPEN",
      url: "https://github.com/example/repo/issues/1",
      external: false,
      partial: false,
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
};

describe("issue canvas", () => {
  it("selects its own native issue ID and keeps the canvas read-only", async () => {
    const select = vi.fn();
    render(<IssueGraphCanvas graph={graph} onSelect={select} />);
    fireEvent.click(await screen.findByRole("button", { name: "Synthetic node" }));
    expect(select).toHaveBeenCalledWith("github-issue:native-1");
    expect(flow.latest).toMatchObject({
      id: "github-issue-flow",
      nodesConnectable: false,
      edgesReconnectable: false,
      deleteKeyCode: null,
    });
    expect(screen.getByRole("region", { name: "GitHub issue graph" })).toHaveAttribute(
      "data-layout-namespace",
      graph.namespace,
    );
  });

  it("fits all issues separately from centering the selected issue", async () => {
    flow.fitView.mockClear();
    render(<IssueGraphCanvas graph={graph} selectedId={graph.nodes[0].id} onSelect={vi.fn()} />);
    await screen.findByRole("button", { name: "Synthetic node" });
    fireEvent.click(screen.getByRole("button", { name: "Fit issues" }));
    expect(flow.fitView.mock.lastCall?.[0].nodes).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Center selected issue" }));
    expect(flow.fitView).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodes: [{ id: graph.nodes[0].id }] }),
    );
  });

  it("allows Fit to contain the full dense fixture even in a narrow canvas", async () => {
    render(<IssueGraphCanvas graph={graph} onSelect={vi.fn()} />);
    await screen.findByRole("button", { name: "Synthetic node" });
    // Bounds from the 235-issue/1130-blocker synthetic projection, with 280x120 cards.
    const bounds = { x: 0, y: 0, width: 41230, height: 17520 };
    for (const [width, height] of [
      [600, 500],
      [260, 280],
    ]) {
      const view = getViewportForBounds(
        bounds,
        width,
        height,
        flow.latest.minZoom,
        flow.latest.maxZoom,
        0.15,
      );
      expect(view.x).toBeGreaterThanOrEqual(0);
      expect(view.y).toBeGreaterThanOrEqual(0);
      expect(view.x + bounds.width * view.zoom).toBeLessThanOrEqual(width);
      expect(view.y + bounds.height * view.zoom).toBeLessThanOrEqual(height);
    }
  });

  it("preserves moved issue positions on refresh and selection without calling code persistence", async () => {
    const { rerender } = render(<IssueGraphCanvas graph={graph} onSelect={vi.fn()} />);
    await screen.findByRole("button", { name: "Synthetic node" });
    act(() =>
      flow.latest.onNodesChange([
        { id: graph.nodes[0].id, type: "position", position: { x: 200, y: 350 } },
      ]),
    );
    rerender(
      <IssueGraphCanvas
        graph={{
          ...graph,
          nodes: graph.nodes.map((node) => ({ ...node, title: "Refreshed node" })),
        }}
        selectedId={graph.nodes[0].id}
        onSelect={vi.fn()}
      />,
    );
    await waitFor(() => expect(flow.latest.nodes[0].position).toEqual({ x: 200, y: 350 }));
    expect(flow.latest.nodes[0].selected).toBe(true);
  });
});
