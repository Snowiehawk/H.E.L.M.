import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceLauncher } from "../routes/useWorkspaceLauncher";

const APP_MENU_EVENT = "helm://app-menu";

function isTauriApp() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface NewProjectMenuBridgeProps {
  enabled?: boolean;
}

export function NewProjectMenuBridge({
  enabled = isTauriApp(),
}: NewProjectMenuBridgeProps = {}) {
  const { createAndIndexProject } = useWorkspaceLauncher();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const detach = await listen<{ action?: string }>(APP_MENU_EVENT, (event) => {
        if (event.payload?.action === "new-project") {
          void createAndIndexProject();
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
  }, [createAndIndexProject, enabled]);

  return null;
}
