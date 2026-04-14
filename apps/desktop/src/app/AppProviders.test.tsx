import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
