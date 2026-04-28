import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOverview,
  buildRepoSession,
  createMockWorkspaceState,
  mockBackendStatus,
} from "../../lib/mocks/mockData";
import type { OverviewData, WorkspaceFileTree } from "../../lib/adapter";
import { SidebarPane } from "./SidebarPane";

function renderSidebarPane(
  options: {
    overview?: OverviewData;
    workspaceFiles?: WorkspaceFileTree;
  } = {},
) {
  const state = createMockWorkspaceState();
  const overview = options.overview ?? buildOverview(buildRepoSession(), state);
  const onSelectModule = vi.fn();
  const onSelectSymbol = vi.fn();
  const onSelectWorkspaceFile = vi.fn();
  const onCreateWorkspaceEntry = vi.fn().mockResolvedValue(undefined);
  const onMoveWorkspaceEntry = vi.fn().mockResolvedValue(undefined);
  const onDeleteWorkspaceEntry = vi.fn().mockResolvedValue(undefined);
  const onOpenPathInDefaultEditor = vi.fn();
  const onRevealPathInFileExplorer = vi.fn();

  render(
    <SidebarPane
      backendStatus={mockBackendStatus}
      overview={overview}
      workspaceFiles={options.workspaceFiles}
      sidebarQuery=""
      searchResults={[]}
      isSearching={false}
      onSidebarQueryChange={vi.fn()}
      onSelectResult={vi.fn()}
      onSelectModule={onSelectModule}
      onSelectSymbol={onSelectSymbol}
      onSelectWorkspaceFile={onSelectWorkspaceFile}
      onCreateWorkspaceEntry={onCreateWorkspaceEntry}
      onMoveWorkspaceEntry={onMoveWorkspaceEntry}
      onDeleteWorkspaceEntry={onDeleteWorkspaceEntry}
      onFocusRepoGraph={vi.fn()}
      onReindexRepo={vi.fn()}
      onOpenRepo={vi.fn()}
      onOpenPathInDefaultEditor={onOpenPathInDefaultEditor}
      onRevealPathInFileExplorer={onRevealPathInFileExplorer}
    />,
  );

  return {
    onSelectModule,
    onSelectSymbol,
    onSelectWorkspaceFile,
    onCreateWorkspaceEntry,
    onMoveWorkspaceEntry,
    onDeleteWorkspaceEntry,
    onOpenPathInDefaultEditor,
    onRevealPathInFileExplorer,
  };
}

function createDragDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "all",
    setData: vi.fn((type: string, value: string) => {
      store.set(type, value);
    }),
    getData: vi.fn((type: string) => store.get(type) ?? ""),
    clearData: vi.fn((type?: string) => {
      if (type) {
        store.delete(type);
        return;
      }
      store.clear();
    }),
  } as unknown as DataTransfer;
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
      onSelectWorkspaceFile: vi.fn(),
      onCreateWorkspaceEntry: vi.fn().mockResolvedValue(undefined),
      onMoveWorkspaceEntry: vi.fn().mockResolvedValue(undefined),
      onDeleteWorkspaceEntry: vi.fn().mockResolvedValue(undefined),
      onFocusRepoGraph: vi.fn(),
      onReindexRepo: vi.fn(),
      onOpenRepo: vi.fn(),
      onOpenPathInDefaultEditor: vi.fn(),
      onRevealPathInFileExplorer: vi.fn(),
    };

    const { rerender } = render(
      <SidebarPane {...sharedProps} selectedFilePath={undefined} selectedNodeId={undefined} />,
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

  it("opens a file context menu with native file actions", async () => {
    const user = userEvent.setup();
    const { onOpenPathInDefaultEditor, onRevealPathInFileExplorer } = renderSidebarPane();

    await user.click(screen.getByRole("treeitem", { name: "helm" }));
    await user.click(screen.getByRole("treeitem", { name: "ui" }));

    const apiFile = screen.getByRole("treeitem", { name: "api.py" });
    fireEvent.contextMenu(apiFile, { clientX: 120, clientY: 80 });

    const menu = screen.getByRole("menu", { name: "api.py actions" });
    expect(within(menu).getByRole("menuitem", { name: "Open in H.E.L.M." })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Show in/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Open in Default App" })).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: /Show in/ }));

    expect(onRevealPathInFileExplorer).toHaveBeenCalledWith(
      "/Users/noahphillips/Documents/git-repos/H.E.L.M./src/helm/ui/api.py",
    );
    expect(onOpenPathInDefaultEditor).not.toHaveBeenCalled();
  });

  it("renders non-Python filesystem entries alongside indexed Python modules", async () => {
    const user = userEvent.setup();
    const { onSelectModule, onSelectWorkspaceFile } = renderSidebarPane({
      workspaceFiles: {
        rootPath: "/Users/noahphillips/Documents/git-repos/H.E.L.M.",
        entries: [
          {
            relativePath: "README.md",
            name: "README.md",
            kind: "file",
            sizeBytes: 8,
            editable: true,
            reason: null,
            modifiedAt: 0,
          },
          {
            relativePath: "src/helm/ui/api.py",
            name: "api.py",
            kind: "file",
            sizeBytes: 1200,
            editable: true,
            reason: null,
            modifiedAt: 0,
          },
        ],
        truncated: false,
      },
    });

    await user.click(screen.getByRole("treeitem", { name: "README.md" }));
    expect(onSelectWorkspaceFile).toHaveBeenCalledWith("README.md");

    const src = screen.getByRole("treeitem", { name: "src" });
    fireEvent.focus(src);
    fireEvent.keyDown(src, { key: "ArrowRight" });
    const helm = await screen.findByRole("treeitem", { name: "helm" });
    fireEvent.focus(helm);
    fireEvent.keyDown(helm, { key: "ArrowRight" });
    const ui = await screen.findByRole("treeitem", { name: "ui" });
    fireEvent.focus(ui);
    fireEvent.keyDown(ui, { key: "ArrowRight" });
    await user.click(screen.getByRole("treeitem", { name: "api.py" }));

    expect(onSelectModule).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleName: "helm.ui.api",
      }),
    );
  });

  it("moves a dragged file into a folder", async () => {
    const { onMoveWorkspaceEntry } = renderSidebarPane({
      workspaceFiles: {
        rootPath: "/Users/noahphillips/Documents/git-repos/H.E.L.M.",
        entries: [
          {
            relativePath: "docs",
            name: "docs",
            kind: "directory",
            sizeBytes: null,
            editable: false,
            reason: "Directories are shown in the explorer.",
            modifiedAt: 0,
          },
          {
            relativePath: "README.md",
            name: "README.md",
            kind: "file",
            sizeBytes: 8,
            editable: true,
            reason: null,
            modifiedAt: 0,
          },
        ],
        truncated: false,
      },
    });
    const readme = screen.getByRole("treeitem", { name: "README.md" });
    const docs = screen.getByRole("treeitem", { name: "docs" });
    const dataTransfer = createDragDataTransfer();

    fireEvent.dragStart(readme, { dataTransfer });
    fireEvent.dragOver(docs, { dataTransfer });
    fireEvent.drop(docs, { dataTransfer });

    await waitFor(() => {
      expect(onMoveWorkspaceEntry).toHaveBeenCalledWith({
        sourceRelativePath: "README.md",
        targetDirectoryRelativePath: "docs",
      });
    });
  });

  it("deletes files through the explorer context menu", async () => {
    const user = userEvent.setup();
    const { onDeleteWorkspaceEntry } = renderSidebarPane({
      workspaceFiles: {
        rootPath: "/Users/noahphillips/Documents/git-repos/H.E.L.M.",
        entries: [
          {
            relativePath: "README.md",
            name: "README.md",
            kind: "file",
            sizeBytes: 8,
            editable: true,
            reason: null,
            modifiedAt: 0,
          },
        ],
        truncated: false,
      },
    });

    const readme = screen.getByRole("treeitem", { name: "README.md" });
    fireEvent.contextMenu(readme, { clientX: 120, clientY: 80 });
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(onDeleteWorkspaceEntry).toHaveBeenCalledWith("README.md");
  });

  it("exposes create actions in an empty filesystem explorer", async () => {
    const user = userEvent.setup();
    const emptyOverview = {
      ...buildOverview(buildRepoSession(), createMockWorkspaceState()),
      modules: [],
    };
    const { onCreateWorkspaceEntry } = renderSidebarPane({
      overview: emptyOverview,
      workspaceFiles: {
        rootPath: "/Users/noahphillips/Documents/git-repos/empty",
        entries: [],
        truncated: false,
      },
    });

    expect(screen.getByText(/This workspace folder is empty/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New File" }));

    const filePathInput = await screen.findByRole("textbox", { name: "New file path" });
    expect(filePathInput).toHaveValue("untitled.txt");

    await user.clear(filePathInput);
    await user.type(filePathInput, "app.py");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(onCreateWorkspaceEntry).toHaveBeenCalledWith({
        kind: "file",
        relativePath: "app.py",
        content: "",
      });
    });

    await user.click(screen.getByRole("button", { name: "New Folder" }));

    const folderPathInput = await screen.findByRole("textbox", { name: "New folder path" });
    expect(folderPathInput).toHaveValue("new-folder");

    await user.clear(folderPathInput);
    await user.type(folderPathInput, "src");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(onCreateWorkspaceEntry).toHaveBeenCalledWith({
        kind: "directory",
        relativePath: "src",
        content: undefined,
      });
    });
  });

  it("copies explorer paths from the context menu", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderSidebarPane();

    await user.click(screen.getByRole("treeitem", { name: "helm" }));
    await user.click(screen.getByRole("treeitem", { name: "ui" }));

    const apiFile = screen.getByRole("treeitem", { name: "api.py" });
    fireEvent.contextMenu(apiFile, { clientX: 120, clientY: 80 });

    await user.click(screen.getByRole("menuitem", { name: "Copy Relative Path" }));

    expect(writeText).toHaveBeenCalledWith("src/helm/ui/api.py");
  });
});
