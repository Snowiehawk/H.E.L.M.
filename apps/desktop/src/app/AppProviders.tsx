import { PropsWithChildren, useEffect, useState } from "react";
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
        {children}
      </AdapterProvider>
    </QueryClientProvider>
  );
}
