import { createContext, PropsWithChildren, useContext } from "react";
import type { DesktopAdapter } from "./contracts";
import { LiveDesktopAdapter } from "./liveDesktopAdapter";
import { MockDesktopAdapter } from "./mockDesktopAdapter";

const AdapterContext = createContext<DesktopAdapter | null>(null);

export function createDesktopAdapter(): DesktopAdapter {
  return "__TAURI_INTERNALS__" in window
    ? new LiveDesktopAdapter()
    : new MockDesktopAdapter();
}

export function AdapterProvider({
  adapter,
  children,
}: PropsWithChildren<{ adapter: DesktopAdapter }>) {
  return (
    <AdapterContext.Provider value={adapter}>{children}</AdapterContext.Provider>
  );
}

export function useDesktopAdapter(): DesktopAdapter {
  const adapter = useContext(AdapterContext);
  if (!adapter) {
    throw new Error("Desktop adapter missing from context.");
  }
  return adapter;
}

export type * from "./contracts";
