import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  WorkspaceHelpBox,
  WorkspaceHelpProvider,
  WorkspaceHelpScope,
  helpTargetProps,
  resolveHelpDescriptor,
  useWorkspaceHelp,
} from "./workspaceHelp";

function HelpHarness() {
  const { setTransientHelpTarget } = useWorkspaceHelp();

  return (
    <>
      <div
        {...helpTargetProps("graph.canvas")}
        data-testid="canvas"
      >
        <button
          {...helpTargetProps("explorer.search")}
          data-testid="search"
          type="button"
        >
          Search
        </button>
      </div>
      <button
        data-testid="edge"
        type="button"
        onMouseEnter={() => {
          setTransientHelpTarget({ id: "graph.edge.controls" });
        }}
        onMouseLeave={() => {
          setTransientHelpTarget(null);
        }}
      >
        Edge
      </button>
      <div data-testid="plain">Plain</div>
      <WorkspaceHelpBox />
    </>
  );
}

describe("workspaceHelp", () => {
  it("resolves semantic help copy for key graph concepts", () => {
    expect(resolveHelpDescriptor("graph.node.module", { label: "api.py" }).title).toBe("api.py module node");
    expect(resolveHelpDescriptor("graph.node.class", { label: "Widget" }).title).toBe("Widget class node");
    expect(resolveHelpDescriptor("graph.node.function", { label: "build_graph" }).description).toMatch(/function/i);
    expect(resolveHelpDescriptor("graph.node.param", { label: "operation" }).description).toMatch(/function signature/i);
    expect(resolveHelpDescriptor("graph.path.flow").description).toMatch(/function flow/i);
    expect(resolveHelpDescriptor("graph.port.imports").description).toMatch(/import relationships/i);
    expect(resolveHelpDescriptor("graph.port.calls").description).toMatch(/call relationships/i);
  });

  it("uses the nearest hovered target, supports transient help, and falls back to idle", async () => {
    const user = userEvent.setup();

    render(
      <WorkspaceHelpProvider>
        <WorkspaceHelpScope data-testid="scope">
          <HelpHarness />
        </WorkspaceHelpScope>
      </WorkspaceHelpProvider>,
    );

    const helpBox = document.querySelector(".workspace-help-box");
    expect(helpBox).not.toBeNull();
    const help = within(helpBox as HTMLElement);

    expect(help.getByText("Hover help")).toBeInTheDocument();

    await user.hover(screen.getByTestId("canvas"));
    expect(help.getByText("Graph canvas")).toBeInTheDocument();

    await user.hover(screen.getByTestId("search"));
    expect(help.getByText("Search")).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTestId("edge"));
    expect(help.getByText("Execution edge")).toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByTestId("edge"));
    await user.hover(screen.getByTestId("plain"));
    expect(help.getByText("Hover help")).toBeInTheDocument();
  });
});
