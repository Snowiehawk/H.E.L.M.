import { PropsWithChildren, useEffect, useState, type CSSProperties } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AdapterProvider,
  createDesktopAdapter,
  DesktopAdapter,
} from "../lib/adapter";
import { useUiStore } from "../store/uiStore";

const GRAPH_VIEW_MENU_EVENT = "helm://graph-view-menu";

function isNativeMacApp() {
  return (
    typeof window !== "undefined"
    && "__TAURI_INTERNALS__" in window
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
    document.documentElement.style.setProperty("--app-ui-scale", String(uiScale));

    if (!isNativeMacApp() && !("__TAURI_INTERNALS__" in window)) {
      return;
    }

    void getCurrentWebview().setZoom(uiScale).catch(() => {
      // Keep the shell usable even if native zoom is unavailable on a given host.
    });
  }, [uiScale]);

  return null;
}

function NativeGraphViewMenuBridge() {
  const graphFilters = useUiStore((state) => state.graphFilters);
  const highlightGraphPath = useUiStore((state) => state.highlightGraphPath);
  const showEdgeLabels = useUiStore((state) => state.showEdgeLabels);
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
      const detach = await listen<{ action?: string }>(GRAPH_VIEW_MENU_EVENT, (event) => {
        switch (event.payload?.action) {
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
  }, [toggleEdgeLabels, toggleGraphFilter, toggleGraphPathHighlight]);

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

export function AppProviders({
  children,
  adapter,
}: PropsWithChildren<{ adapter?: DesktopAdapter }>) {
  const uiScale = useUiStore((state) => state.uiScale);
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
        <NativeGraphViewMenuBridge />
        <div
          className="app-scale-shell"
          style={{ "--app-ui-scale": String(uiScale) } as CSSProperties}
        >
          {children}
        </div>
      </AdapterProvider>
    </QueryClientProvider>
  );
}
