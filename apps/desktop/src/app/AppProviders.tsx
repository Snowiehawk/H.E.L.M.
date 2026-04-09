import { PropsWithChildren, useEffect, useState, type CSSProperties } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  AdapterProvider,
  createDesktopAdapter,
  DesktopAdapter,
} from "../lib/adapter";
import { useUiStore } from "../store/uiStore";

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
