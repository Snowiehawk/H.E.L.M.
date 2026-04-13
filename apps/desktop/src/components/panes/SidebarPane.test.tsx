import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOverview,
  buildRepoSession,
  createMockWorkspaceState,
  mockBackendStatus,
} from "../../lib/mocks/mockData";
import { SidebarPane } from "./SidebarPane";

function renderSidebarPane() {
  const state = createMockWorkspaceState();
  const overview = buildOverview(buildRepoSession(), state);
  const onSelectModule = vi.fn();
  const onSelectSymbol = vi.fn();

  render(
    <SidebarPane
      backendStatus={mockBackendStatus}
      overview={overview}
      sidebarQuery=""
      searchResults={[]}
      isSearching={false}
      onSidebarQueryChange={vi.fn()}
      onSelectResult={vi.fn()}
      onSelectModule={onSelectModule}
      onSelectSymbol={onSelectSymbol}
      onFocusRepoGraph={vi.fn()}
      onReindexRepo={vi.fn()}
      onOpenRepo={vi.fn()}
    />,
  );

  return {
    onSelectModule,
    onSelectSymbol,
  };
}

describe("SidebarPane", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps nested folders collapsed until you open them", async () => {
    const user = userEvent.setup();

    renderSidebarPane();

    const src = screen.getByRole("treeitem", { name: "src" });
    const helm = screen.getByRole("treeitem", { name: "helm" });

    expect(src).toHaveAttribute("aria-expanded", "true");
    expect(helm).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "graph" })).not.toBeInTheDocument();

    await user.click(helm);

    expect(helm).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: "graph" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "ui" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "cli.py" })).toBeInTheDocument();
  });

  it("supports arrow-key navigation like a file explorer", async () => {
    const user = userEvent.setup();
    const { onSelectModule, onSelectSymbol } = renderSidebarPane();

    const src = screen.getByRole("treeitem", { name: "src" });
    src.focus();

    await user.keyboard("{ArrowRight}");

    const helm = screen.getByRole("treeitem", { name: "helm" });
    expect(helm).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(helm).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{ArrowDown}{ArrowDown}");

    const ui = screen.getByRole("treeitem", { name: "ui" });
    expect(ui).toHaveFocus();

    await user.keyboard("{ArrowDown}{ArrowDown}");

    const cli = screen.getByRole("treeitem", { name: "cli.py" });
    expect(cli).toHaveFocus();

    await user.keyboard("{Enter}");

    expect(onSelectModule).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleName: "helm.cli",
      }),
    );

    expect(screen.queryByRole("treeitem", { name: "main" })).not.toBeInTheDocument();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("treeitem", { name: "main" })).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");

    const main = screen.getByRole("treeitem", { name: "main" });
    expect(main).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onSelectSymbol).toHaveBeenCalledWith("symbol:helm.cli:main");

    await user.keyboard("{ArrowLeft}");
    expect(cli).toHaveFocus();
  });

  it("treats file rows as selectable modules with separate expandable outlines", async () => {
    const user = userEvent.setup();
    const { onSelectModule } = renderSidebarPane();

    await user.click(screen.getByRole("treeitem", { name: "helm" }));
    await user.click(screen.getByRole("treeitem", { name: "ui" }));

    const apiFile = screen.getByRole("treeitem", { name: "api.py" });
    await user.click(apiFile);

    expect(onSelectModule).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleName: "helm.ui.api",
      }),
    );
    expect(screen.queryByRole("treeitem", { name: "GraphSummary" })).not.toBeInTheDocument();

    apiFile.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("treeitem", { name: "GraphSummary" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "build_graph_summary" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "build_export_payload" })).toBeInTheDocument();
  });

  it("shows kind badges for folders, files, and outline symbols", async () => {
    const user = userEvent.setup();

    renderSidebarPane();

    const src = screen.getByRole("treeitem", { name: "src" });
    expect(within(src).getByText("dir")).toBeInTheDocument();

    await user.click(screen.getByRole("treeitem", { name: "helm" }));

    const cli = screen.getByRole("treeitem", { name: "cli.py" });
    expect(within(cli).getByText("file")).toBeInTheDocument();

    await user.click(cli);
    await user.keyboard("{ArrowRight}");

    const main = screen.getByRole("treeitem", { name: "main" });
    expect(within(main).getByText("fn")).toBeInTheDocument();
  });

  it("scrolls the selected row into view when selection changes externally", async () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    const state = createMockWorkspaceState();
    const overview = buildOverview(buildRepoSession(), state);
    const onSelectModule = vi.fn();
    const onSelectSymbol = vi.fn();
    const sharedProps = {
      backendStatus: mockBackendStatus,
      overview,
      sidebarQuery: "",
      searchResults: [],
      isSearching: false,
      onSidebarQueryChange: vi.fn(),
      onSelectResult: vi.fn(),
      onSelectModule,
      onSelectSymbol,
      onFocusRepoGraph: vi.fn(),
      onReindexRepo: vi.fn(),
      onOpenRepo: vi.fn(),
    };

    const { rerender } = render(
      <SidebarPane
        {...sharedProps}
        selectedFilePath={undefined}
        selectedNodeId={undefined}
      />,
    );

    rerender(
      <SidebarPane
        {...sharedProps}
        selectedFilePath={undefined}
        selectedNodeId="symbol:helm.ui.api:build_graph_summary"
      />,
    );

    const symbolRow = await screen.findByRole("treeitem", { name: "build_graph_summary" });

    await waitFor(() => {
      const lastScrolledElement =
        scrollIntoView.mock.instances[scrollIntoView.mock.instances.length - 1];
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(lastScrolledElement).toBe(symbolRow);
    });
  });
});
