import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../components/CommandPalette";
import { IssueRepositoryAdapter } from "../issues/IssueRepositoryAdapter";
import type { IssueGraph } from "../issues/issueGraph";
import { issue, page, repositoryName, response, TEST_TOKEN } from "../issues/test-fixtures/github";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { useUiStore } from "../store/uiStore";
import { useUndoStore } from "../store/undoStore";
import { AppProviders } from "./AppProviders";
import { FunctionTabsProvider } from "./FunctionTabs";
import { FunctionTabsShell } from "./FunctionTabsShell";

vi.mock("../issues/IssueGraphCanvas", () => ({
  IssueGraphCanvas: ({
    graph,
    selectedId,
    onSelect,
  }: {
    graph: IssueGraph;
    selectedId?: string;
    onSelect: (id: string) => void;
  }) => (
    <section aria-label="GitHub issue graph" data-layout-namespace={graph.namespace}>
      {graph.nodes.map((node) => (
        <button
          key={node.id}
          aria-pressed={selectedId === node.id}
          onClick={() => onSelect(node.id)}
        >
          Graph node {node.number}
        </button>
      ))}
    </section>
  ),
}));

function IdeProbe() {
  const [draft, setDraft] = useState("unsaved IDE draft");
  return (
    <>
      <label>
        Code draft
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <CommandPalette />
    </>
  );
}
function renderTabs(adapter: IssueRepositoryAdapter) {
  return render(
    <FunctionTabsProvider>
      <AppProviders adapter={new MockDesktopAdapter()}>
        <FunctionTabsShell issueAdapter={adapter}>
          <IdeProbe />
        </FunctionTabsShell>
      </AppProviders>
    </FunctionTabsProvider>,
  );
}

beforeEach(() => {
  useUndoStore.getState().resetSession(undefined);
  useUiStore.setState({
    repoSession: undefined,
    paletteOpen: false,
    preferencesOpen: false,
    activeNodeId: "symbol:synthetic:code",
    graphTargetId: "module:synthetic",
    graphFilters: { includeCalls: false, includeImports: true, includeDefines: true },
  });
});

describe("separate desktop functionality tabs", () => {
  it("keeps IDE drafts/state mounted and preserves the independent issue session across tab switches", async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response(page([issue(1, [], [2]), issue(2, [1])])));
    const adapter = new IssueRepositoryAdapter(fetcher);
    renderTabs(adapter);
    const draft = screen.getByLabelText("Code draft");
    await user.type(draft, " edited");
    const codeState = {
      selected: useUiStore.getState().activeNodeId,
      target: useUiStore.getState().graphTargetId,
      filters: useUiStore.getState().graphFilters,
    };
    await user.click(screen.getByRole("tab", { name: "GitHub issues" }));
    expect(draft).not.toBeVisible();
    await user.type(screen.getByLabelText("Repository URL or owner/name"), repositoryName);
    await user.type(screen.getByLabelText("Personal access token"), TEST_TOKEN);
    await user.click(screen.getByRole("button", { name: "Load issues" }));
    await user.click(await screen.findByRole("button", { name: "Graph node 2" }));
    expect(
      within(screen.getByLabelText("Issue details")).getByRole("heading", {
        name: "#2: Synthetic issue 2",
      }),
    ).toBeInTheDocument();
    await user.click(
      within(screen.getByLabelText("Issue details")).getByRole("button", {
        name: "#1: Synthetic issue 1",
      }),
    );
    expect(screen.getByRole("heading", { name: "#1: Synthetic issue 1" })).toBeInTheDocument();
    await user.click(
      within(screen.getByLabelText("Issue details")).getByRole("button", {
        name: "#2: Synthetic issue 2",
      }),
    );
    expect(screen.getByRole("region", { name: "GitHub issue graph" })).toHaveAttribute(
      "data-layout-namespace",
      `github-issues|synthetic-repository-${repositoryName}|overview`,
    );
    await user.click(screen.getByRole("tab", { name: "IDE" }));
    expect(screen.getByLabelText("Code draft")).toBe(draft);
    expect(draft).toHaveValue("unsaved IDE draft edited");
    expect({
      selected: useUiStore.getState().activeNodeId,
      target: useUiStore.getState().graphTargetId,
      filters: useUiStore.getState().graphFilters,
    }).toEqual(codeState);
    await user.click(screen.getByRole("tab", { name: "GitHub issues" }));
    expect(screen.getByRole("heading", { name: "#2: Synthetic issue 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh issues" })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Refresh issues" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "#2: Synthetic issue 2" })).toBeInTheDocument();
    fetcher.mockResolvedValueOnce(response({ message: TEST_TOKEN }, 503));
    await user.click(screen.getByRole("button", { name: "Refresh issues" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub returned HTTP 503. Showing the previous successful load.",
    );
    expect(screen.getByRole("heading", { name: "#2: Synthetic issue 2" })).toBeInTheDocument();
    expect(screen.queryByText(TEST_TOKEN)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(adapter.getState().snapshot).toBeUndefined();
    expect(screen.queryByRole("region", { name: "GitHub issue graph" })).not.toBeInTheDocument();
  });

  it("clears credentials and issue presentation on close, and reopens a blank viewer", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page()));
    const adapter = new IssueRepositoryAdapter(fetcher);
    await adapter.load(repositoryName, TEST_TOKEN);
    renderTabs(adapter);
    await user.click(screen.getByRole("tab", { name: "GitHub issues" }));
    expect(screen.getByRole("region", { name: "GitHub issue graph" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close issue viewer" }));
    expect(adapter.getState()).toEqual({ status: "idle", canRefresh: false });
    expect(screen.getByRole("tab", { name: "IDE" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "GitHub issues" }));
    expect(screen.getByLabelText("Personal access token")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Refresh issues" })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "GitHub issue graph" })).not.toBeInTheDocument();
  });

  it("does not send issue-tab shortcuts to hidden IDE undo or command-palette handlers", async () => {
    const user = userEvent.setup();
    renderTabs(new IssueRepositoryAdapter(vi.fn<typeof fetch>()));
    const undo = vi.fn();
    let detach = () => {};
    act(() => {
      detach = useUndoStore.getState().registerDomain("editor", { canUndo: () => true, undo });
    });
    await user.click(screen.getByRole("tab", { name: "GitHub issues" }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
    expect(useUiStore.getState().paletteOpen).toBe(false);
    await user.click(screen.getByRole("tab", { name: "IDE" }));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    detach();
  });
});
