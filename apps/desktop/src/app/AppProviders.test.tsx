import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppWindowActions } from "../components/shared/AppWindowActions";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { useUiStore } from "../store/uiStore";
import { useUndoStore } from "../store/undoStore";
import { AppProviders } from "./AppProviders";

function clearLocalStorage() {
  if (typeof window.localStorage?.clear === "function") {
    window.localStorage.clear();
  }
}

function resetStore() {
  const current = useUiStore.getState();
  clearLocalStorage();
  useUndoStore.getState().resetSession(undefined);
  useUiStore.setState({
    ...current,
    theme: "system",
    uiScale: 1,
    preferencesOpen: false,
    paletteOpen: false,
    sidebarQuery: "",
    activeTab: "graph",
    repoSession: undefined,
    activeFilePath: undefined,
    activeSymbolId: undefined,
    activeNodeId: undefined,
    graphTargetId: undefined,
    activeLevel: "module",
    graphDepth: 1,
    graphFilters: {
      includeImports: true,
      includeCalls: true,
      includeDefines: true,
    },
    graphSettings: {
      includeExternalDependencies: false,
    },
    flowInputDisplayMode: "param_nodes",
    highlightGraphPath: true,
    showEdgeLabels: true,
    revealedSource: undefined,
    lastEdit: undefined,
    lastActivity: undefined,
  });
}

describe("AppProviders", () => {
  beforeEach(() => {
    resetStore();
  });

  it("applies app-level UI scale shortcuts", () => {
    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <div>Scale target</div>
      </AppProviders>,
    );

    const scaleShell = document.querySelector(".app-scale-shell");
    expect(scaleShell).not.toBeNull();
    expect(screen.getByText("Scale target")).toBeInTheDocument();
    expect(useUiStore.getState().uiScale).toBe(1);

    fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    expect(useUiStore.getState().uiScale).toBe(1.1);

    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(useUiStore.getState().uiScale).toBe(1);

    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    expect(useUiStore.getState().uiScale).toBe(1);
  });

  it("opens preferences from the global shortcut", () => {
    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <div>Preferences target</div>
      </AppProviders>,
    );

    expect(screen.queryByRole("dialog", { name: /preferences/i })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: ",", code: "Comma", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: /preferences/i })).toBeInTheDocument();

    const sectionNav = screen.getByRole("navigation", { name: "Preferences" });
    expect(within(sectionNav).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "General",
      "Appearance",
      "Graph",
      "Flow",
    ]);
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByText("Interface scale")).toBeInTheDocument();

    fireEvent.click(within(sectionNav).getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(useUiStore.getState().theme).toBe("dark");

    fireEvent.click(within(sectionNav).getByRole("button", { name: "Graph" }));
    fireEvent.click(screen.getByRole("switch", { name: "Show external dependencies" }));
    expect(useUiStore.getState().graphSettings.includeExternalDependencies).toBe(true);

    fireEvent.click(within(sectionNav).getByRole("button", { name: "Flow" }));
    fireEvent.click(screen.getByRole("button", { name: "Entry inputs" }));
    expect(useUiStore.getState().flowInputDisplayMode).toBe("entry");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /preferences/i })).not.toBeInTheDocument();
  });

  it("opens preferences from the window gear button", () => {
    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <AppWindowActions />
      </AppProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: /open preferences/i }));
    expect(screen.getByRole("dialog", { name: /preferences/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /back to app/i }));
    expect(screen.queryByRole("dialog", { name: /preferences/i })).not.toBeInTheDocument();
  });

  it("routes global undo to the focused editor first, then falls through to saved domain history", async () => {
    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <div>Undo target</div>
      </AppProviders>,
    );

    let editorCanUndo = true;
    let editorOwnsFocus = true;
    const editorUndo = vi.fn().mockResolvedValue({ domain: "editor", handled: true });
    const backendUndo = vi.fn().mockResolvedValue({ domain: "backend", handled: true });

    const unregisterEditor = useUndoStore.getState().registerDomain("editor", {
      canUndo: () => editorCanUndo,
      ownsFocus: () => editorOwnsFocus,
      undo: editorUndo,
    });
    const unregisterBackend = useUndoStore.getState().registerDomain("backend", {
      canUndo: () => true,
      peekEntry: () => ({
        domain: "backend",
        summary: "Saved backend edit",
        createdAt: Date.now(),
      }),
      undo: backendUndo,
    });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(editorUndo).toHaveBeenCalledTimes(1));
    expect(backendUndo).not.toHaveBeenCalled();

    editorCanUndo = false;
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(backendUndo).toHaveBeenCalledTimes(1));

    unregisterEditor();
    unregisterBackend();
  });

  it("routes global redo to the focused editor first, then falls through to saved domain history", async () => {
    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <div>Redo target</div>
      </AppProviders>,
    );

    let editorCanRedo = true;
    let editorOwnsFocus = true;
    const editorRedo = vi.fn().mockResolvedValue({ domain: "editor", handled: true });
    const backendRedo = vi.fn().mockResolvedValue({ domain: "backend", handled: true });

    const unregisterEditor = useUndoStore.getState().registerDomain("editor", {
      canUndo: () => false,
      canRedo: () => editorCanRedo,
      ownsFocus: () => editorOwnsFocus,
      undo: vi.fn(),
      redo: editorRedo,
    });
    const unregisterBackend = useUndoStore.getState().registerDomain("backend", {
      canUndo: () => false,
      canRedo: () => true,
      peekRedoEntry: () => ({
        domain: "backend",
        summary: "Saved backend edit",
        createdAt: Date.now(),
      }),
      undo: vi.fn(),
      redo: backendRedo,
    });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(editorRedo).toHaveBeenCalledTimes(1));
    expect(backendRedo).not.toHaveBeenCalled();

    editorCanRedo = false;
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(backendRedo).toHaveBeenCalledTimes(1));

    unregisterEditor();
    unregisterBackend();
  });

  it("clears registered undo domains when the repo session changes", async () => {
    const current = useUiStore.getState();
    useUiStore.setState({
      ...current,
      repoSession: {
        id: "repo:/workspace/one",
        name: "one",
        path: "/workspace/one",
        branch: "main",
        primaryLanguage: "Python",
        openedAt: "2026-04-13T00:00:00.000Z",
      },
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <div>Session target</div>
      </AppProviders>,
    );

    useUndoStore.getState().registerDomain("backend", {
      canUndo: () => true,
      peekEntry: () => ({
        domain: "backend",
        summary: "Saved backend edit",
        createdAt: Date.now(),
      }),
      undo: () => ({ domain: "backend", handled: true }),
    });

    expect(useUndoStore.getState().getPreferredUndoDomain()).toBe("backend");

    act(() => {
      useUiStore.setState({
        ...useUiStore.getState(),
        repoSession: {
          id: "repo:/workspace/two",
          name: "two",
          path: "/workspace/two",
          branch: "main",
          primaryLanguage: "Python",
          openedAt: "2026-04-13T00:01:00.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(useUndoStore.getState().getPreferredUndoDomain()).toBeUndefined();
    });
  });
});
