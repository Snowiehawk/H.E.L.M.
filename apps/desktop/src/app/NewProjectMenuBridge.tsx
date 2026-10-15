import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceLauncher } from "../routes/useWorkspaceLauncher";
import { useIdeActive } from "./FunctionTabs";

const APP_MENU_EVENT = "helm://app-menu";

function isTauriApp() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

interface NewProjectMenuBridgeProps {
  enabled?: boolean;
}

export function NewProjectMenuBridge({ enabled = isTauriApp() }: NewProjectMenuBridgeProps = {}) {
  const ideActive = useIdeActive();
  const ideActiveRef = useRef(ideActive);
  ideActiveRef.current = ideActive;
  const { createAndIndexProject } = useWorkspaceLauncher();

  useEffect(() => {
    if (!enabled || !ideActive) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const detach = await listen<{ action?: string }>(APP_MENU_EVENT, (event) => {
        if (ideActiveRef.current && event.payload?.action === "new-project") {
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
  }, [createAndIndexProject, enabled, ideActive]);

  return null;
}
