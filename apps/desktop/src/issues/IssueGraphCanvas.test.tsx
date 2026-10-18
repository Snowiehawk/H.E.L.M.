import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getViewportForBounds } from "@xyflow/react";
import { IssueGraphCanvas } from "./IssueGraphCanvas";
import type { IssueGraph } from "./issueGraph";

const flow = vi.hoisted(() => ({ fitView: vi.fn(), latest: {} as any }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    ReactFlow: (props: any) => {
      flow.latest = props;
      useEffect(() => {
        props.onInit(flow);
      }, []);
      return (
        <div>
          {props.nodes.map((node: any) => {
            const Card = props.nodeTypes.issue;
            return (
              <button
                key={node.id}
                aria-label={node.ariaLabel}
                onClick={() => props.onNodeClick({}, node)}
              >
                <Card data={node.data} />
              </button>
            );
          })}
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
  it("labels binary colors, external/partial cards and neutral unavailable state without progress inference", async () => {
    const nodes = [
      graph.nodes[0],
      {
        ...graph.nodes[0],
        id: "closed",
        number: 2,
        title: "Not planned",
        state: "CLOSED" as const,
        external: true,
        partial: true,
      },
      {
        ...graph.nodes[0],
        id: "unavailable",
        number: 3,
        title: "Unavailable fixture",
        state: undefined as any,
      },
    ];
    render(<IssueGraphCanvas graph={{ ...graph, nodes }} onSelect={vi.fn()} />);
    const open = await screen.findByRole("button", { name: "Issue 1: Synthetic node, Open" });
    expect(within(open).getByText("Open")).toHaveClass("issue-state-label");
    expect(open.querySelector(".issue-graph-card")).toHaveAttribute("data-issue-state", "open");
    const closed = screen.getByRole("button", {
      name: "Issue 2: Not planned, Closed, external, partial blocker data",
    });
    expect(closed.querySelector(".issue-graph-card")).toHaveClass("is-external");
    expect(closed.querySelector(".issue-graph-card")).toHaveAttribute("data-issue-state", "closed");
    expect(within(closed).getByText(/partial blockers/)).toBeVisible();
    const unknown = screen.getByRole("button", {
      name: "Issue 3: Unavailable fixture, State unavailable",
    });
    expect(unknown.querySelector(".issue-graph-card")).toHaveAttribute(
      "data-issue-state",
      "unavailable",
    );
    expect(within(unknown).getByText("State unavailable")).toBeVisible();
    const legend = screen.getByRole("list", { name: "Issue state legend" });
    expect(within(legend).getByText(/Open/)).toBeVisible();
    expect(within(legend).getByText(/Closed/)).toBeVisible();
    expect(screen.queryByText(/in progress|completed/i)).not.toBeInTheDocument();
  });

  it("selects its own native issue ID and keeps the canvas read-only", async () => {
    const select = vi.fn();
    render(<IssueGraphCanvas graph={graph} onSelect={select} />);
    fireEvent.click(await screen.findByText("Synthetic node"));
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
    await screen.findByText("Synthetic node");
    fireEvent.click(screen.getByRole("button", { name: "Fit issues" }));
    expect(flow.fitView.mock.lastCall?.[0].nodes).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Center selected issue" }));
    expect(flow.fitView).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodes: [{ id: graph.nodes[0].id }] }),
    );
  });

  it("allows Fit to contain the full dense fixture even in a narrow canvas", async () => {
    render(<IssueGraphCanvas graph={graph} onSelect={vi.fn()} />);
    await screen.findByText("Synthetic node");
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
    await screen.findByText("Synthetic node");
    act(() =>
      flow.latest.onNodesChange([
        { id: graph.nodes[0].id, type: "position", position: { x: 200, y: 350 } },
      ]),
    );
    rerender(
      <IssueGraphCanvas
        graph={{
          ...graph,
          nodes: graph.nodes.map((node) => ({
            ...node,
            title: "Refreshed node",
            state: "CLOSED" as const,
          })),
        }}
        selectedId={graph.nodes[0].id}
        onSelect={vi.fn()}
      />,
    );
    await waitFor(() => expect(flow.latest.nodes[0].position).toEqual({ x: 200, y: 350 }));
    expect(flow.latest.nodes[0].selected).toBe(true);
    expect(flow.latest.nodes[0].ariaLabel).toContain("Closed");
    expect(screen.getByText("Refreshed node").closest("[data-issue-state]")).toHaveAttribute(
      "data-issue-state",
      "closed",
    );
    rerender(<IssueGraphCanvas graph={graph} selectedId={graph.nodes[0].id} onSelect={vi.fn()} />);
    await waitFor(() => expect(flow.latest.nodes[0].ariaLabel).toContain("Open"));
    expect(flow.latest.nodes[0].position).toEqual({ x: 200, y: 350 });
    expect(flow.latest.nodes[0].selected).toBe(true);
  });
});
