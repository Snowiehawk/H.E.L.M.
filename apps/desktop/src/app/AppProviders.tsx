import { PropsWithChildren, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AdapterProvider,
  createDesktopAdapter,
  DesktopAdapter,
} from "../lib/adapter";
import { PreferencesDialog } from "../components/shared/PreferencesDialog";
import { useUiStore } from "../store/uiStore";
import { useUndoStore } from "../store/undoStore";

const APP_MENU_EVENT = "helm://app-menu";

function isTauriApp() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isNativeMacApp() {
  return (
    isTauriApp()
    && typeof navigator !== "undefined"
    && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
  );
}

function ThemeBridge() {
  const theme = useUiStore((state) => state.theme);

  useEffect(() => {
    const prefersDark =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved =
      theme === "system"
        ? prefersDark
          ? "dark"
          : "light"
        : theme;
    document.documentElement.dataset.theme = resolved;
  }, [theme]);

  return null;
}

function UiScaleBridge() {
  const uiScale = useUiStore((state) => state.uiScale);
  const increaseUiScale = useUiStore((state) => state.increaseUiScale);
  const decreaseUiScale = useUiStore((state) => state.decreaseUiScale);
  const resetUiScale = useUiStore((state) => state.resetUiScale);

  useEffect(() => {
    if (isNativeMacApp()) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }

      const isZoomInKey =
        event.key === "="
        || event.key === "+"
        || event.code === "NumpadAdd";
      const isZoomOutKey =
        event.key === "-"
        || event.key === "_"
        || event.code === "NumpadSubtract";
      const isResetKey =
        event.key === "0"
        || event.code === "Numpad0";

      if (!isZoomInKey && !isZoomOutKey && !isResetKey) {
        return;
      }

      event.preventDefault();

      if (isZoomInKey) {
        increaseUiScale();
        return;
      }

      if (isZoomOutKey) {
        decreaseUiScale();
        return;
      }

      resetUiScale();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [decreaseUiScale, increaseUiScale, resetUiScale]);

  useEffect(() => {
    if (!isTauriApp()) {
      return;
    }

    void getCurrentWebview().setZoom(uiScale).catch((error) => {
      console.warn("Unable to apply native webview zoom.", error);
    });
  }, [uiScale]);

  return null;
}

function NativeMacMenuBridge() {
  const graphFilters = useUiStore((state) => state.graphFilters);
  const highlightGraphPath = useUiStore((state) => state.highlightGraphPath);
  const showEdgeLabels = useUiStore((state) => state.showEdgeLabels);
  const increaseUiScale = useUiStore((state) => state.increaseUiScale);
  const decreaseUiScale = useUiStore((state) => state.decreaseUiScale);
  const resetUiScale = useUiStore((state) => state.resetUiScale);
  const setPreferencesOpen = useUiStore((state) => state.setPreferencesOpen);
  const toggleGraphFilter = useUiStore((state) => state.toggleGraphFilter);
  const toggleGraphPathHighlight = useUiStore((state) => state.toggleGraphPathHighlight);
  const toggleEdgeLabels = useUiStore((state) => state.toggleEdgeLabels);

  useEffect(() => {
    if (!isNativeMacApp()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const detach = await listen<{ action?: string }>(APP_MENU_EVENT, (event) => {
        switch (event.payload?.action) {
          case "undo":
            dispatchGlobalUndo();
            break;
          case "redo":
            dispatchGlobalRedo();
            break;
          case "zoom-in":
            increaseUiScale();
            break;
          case "zoom-out":
            decreaseUiScale();
            break;
          case "zoom-reset":
            resetUiScale();
            break;
          case "preferences":
            setPreferencesOpen(true);
            break;
          case "toggle-calls":
            toggleGraphFilter("includeCalls");
            break;
          case "toggle-imports":
            toggleGraphFilter("includeImports");
            break;
          case "toggle-defines":
            toggleGraphFilter("includeDefines");
            break;
          case "toggle-path-highlight":
            toggleGraphPathHighlight();
            break;
          case "toggle-edge-labels":
            toggleEdgeLabels();
            break;
          default:
            break;
        }
      });

      if (disposed) {
        detach();
        return;
      }

      unlisten = detach;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    decreaseUiScale,
    increaseUiScale,
    resetUiScale,
    setPreferencesOpen,
    toggleEdgeLabels,
    toggleGraphFilter,
    toggleGraphPathHighlight,
  ]);

  useEffect(() => {
    if (!isNativeMacApp()) {
      return;
    }

    void (async () => {
      await invoke("sync_graph_view_menu_state", {
        stateJson: JSON.stringify({
          includeCalls: graphFilters.includeCalls,
          includeImports: graphFilters.includeImports,
          includeDefines: graphFilters.includeDefines,
          highlightGraphPath,
          showEdgeLabels,
        }),
      });
    })();
  }, [
    graphFilters.includeCalls,
    graphFilters.includeDefines,
    graphFilters.includeImports,
    highlightGraphPath,
    showEdgeLabels,
  ]);

  return null;
}

function PreferencesShortcutBridge() {
  const setPreferencesOpen = useUiStore((state) => state.setPreferencesOpen);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || !(event.metaKey || event.ctrlKey)
        || event.altKey
        || event.shiftKey
        || (event.key !== "," && event.code !== "Comma")
      ) {
        return;
      }

      event.preventDefault();
      setPreferencesOpen(true);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [setPreferencesOpen]);

  return null;
}

function isMonacoEditingTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && Boolean(target.closest(".monaco-editor, .monaco-diff-editor"));
}

function isNativeTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (isMonacoEditingTarget(target)) {
    return false;
  }

  const editableHost = target.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
  );
  return editableHost instanceof HTMLElement;
}

function dispatchNativeBrowserEditCommand(commandId: "undo" | "redo") {
  const documentWithEditCommand = document as Document & {
    execCommand?: (commandId: string) => boolean;
  };
  if (typeof documentWithEditCommand.execCommand === "function") {
    documentWithEditCommand.execCommand(commandId);
  }
}

function dispatchGlobalUndo() {
  const activeTarget = document.activeElement;
  if (isNativeTextEditingTarget(activeTarget)) {
    dispatchNativeBrowserEditCommand("undo");
    return;
  }

  const domain = useUndoStore.getState().getPreferredUndoDomain();
  if (!domain) {
    return;
  }

  void useUndoStore.getState().performUndo();
}

function dispatchGlobalRedo() {
  const activeTarget = document.activeElement;
  if (isNativeTextEditingTarget(activeTarget)) {
    dispatchNativeBrowserEditCommand("redo");
    return;
  }

  const domain = useUndoStore.getState().getPreferredRedoDomain();
  if (!domain) {
    return;
  }

  void useUndoStore.getState().performRedo();
}

function GlobalUndoRedoBridge() {
  const repoSessionId = useUiStore((state) => state.repoSession?.id);
  const resetUndoSession = useUndoStore((state) => state.resetSession);

  useEffect(() => {
    resetUndoSession(repoSessionId);
  }, [repoSessionId, resetUndoSession]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || !(event.metaKey || event.ctrlKey)
        || event.altKey
        || event.key.toLowerCase() !== "z"
      ) {
        return;
      }

      if (isNativeTextEditingTarget(event.target)) {
        return;
      }

      const isRedo = event.shiftKey;
      const undoStore = useUndoStore.getState();
      const domain = isRedo
        ? undoStore.getPreferredRedoDomain()
        : undoStore.getPreferredUndoDomain();
      if (!domain) {
        return;
      }

      event.preventDefault();
      void (isRedo ? undoStore.performRedo() : undoStore.performUndo());
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  return null;
}

export function AppProviders({
  children,
  adapter,
}: PropsWithChildren<{ adapter?: DesktopAdapter }>) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 20_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const [resolvedAdapter] = useState(() => adapter ?? createDesktopAdapter());

  return (
    <QueryClientProvider client={queryClient}>
      <AdapterProvider adapter={resolvedAdapter}>
        <ThemeBridge />
        <UiScaleBridge />
        <GlobalUndoRedoBridge />
        <PreferencesShortcutBridge />
        <NativeMacMenuBridge />
        <div className="app-scale-shell">{children}</div>
        <PreferencesDialog />
      </AdapterProvider>
    </QueryClientProvider>
  );
}
