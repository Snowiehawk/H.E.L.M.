import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  clampExplorerSidebarWidth,
  DEFAULT_EXPLORER_SIDEBAR_WIDTH,
  EXPLORER_SIDEBAR_WIDTH_STORAGE_KEY,
  INSPECTOR_DRAWER_HEIGHT_STORAGE_KEY,
  readStoredExplorerSidebarWidth,
  readStoredInspectorDrawerHeight,
} from "./workspaceScreenModel";

export function useWorkspaceLayout() {
  const [inspectorDrawerHeight, setInspectorDrawerHeight] = useState(
    readStoredInspectorDrawerHeight,
  );
  const [explorerSidebarWidth, setExplorerSidebarWidth] = useState(readStoredExplorerSidebarWidth);
  const workspaceLayoutRef = useRef<HTMLDivElement>(null);
  const [workspaceLayoutWidth, setWorkspaceLayoutWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
      return;
    }

    window.localStorage.setItem(
      INSPECTOR_DRAWER_HEIGHT_STORAGE_KEY,
      String(Math.round(inspectorDrawerHeight)),
    );
  }, [inspectorDrawerHeight]);

  useEffect(() => {
    const layout = workspaceLayoutRef.current;
    if (!(layout instanceof HTMLElement)) {
      return;
    }

    const updateWidth = () => {
      setWorkspaceLayoutWidth(layout.clientWidth || window.innerWidth || 1280);
    };

    updateWidth();

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        updateWidth();
      });
      observer.observe(layout);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
      return;
    }

    window.localStorage.setItem(
      EXPLORER_SIDEBAR_WIDTH_STORAGE_KEY,
      String(Math.round(explorerSidebarWidth)),
    );
  }, [explorerSidebarWidth]);

  const narrowWorkspaceLayout = workspaceLayoutWidth <= 920;
  const clampedExplorerSidebarWidth = useMemo(
    () => clampExplorerSidebarWidth(explorerSidebarWidth, workspaceLayoutWidth),
    [explorerSidebarWidth, workspaceLayoutWidth],
  );

  useEffect(() => {
    if (narrowWorkspaceLayout || clampedExplorerSidebarWidth === explorerSidebarWidth) {
      return;
    }

    setExplorerSidebarWidth(clampedExplorerSidebarWidth);
  }, [clampedExplorerSidebarWidth, explorerSidebarWidth, narrowWorkspaceLayout]);

  const handleExplorerSidebarResize = useCallback(
    (nextWidth: number) => {
      setExplorerSidebarWidth(clampExplorerSidebarWidth(nextWidth, workspaceLayoutWidth));
    },
    [workspaceLayoutWidth],
  );

  const handleExplorerResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (narrowWorkspaceLayout) {
        return;
      }

      const layoutLeft = workspaceLayoutRef.current?.getBoundingClientRect().left ?? 0;

      event.preventDefault();

      const resizeFromClientX = (clientX: number) => {
        if (!Number.isFinite(clientX)) {
          return;
        }

        handleExplorerSidebarResize(clientX - layoutLeft);
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        resizeFromClientX(moveEvent.clientX);
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        resizeFromClientX(moveEvent.clientX);
      };

      const stopResize = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", stopResize);
      };

      resizeFromClientX(event.clientX);
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", stopResize);
    },
    [handleExplorerSidebarResize, narrowWorkspaceLayout],
  );

  const handleExplorerResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (narrowWorkspaceLayout) {
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        handleExplorerSidebarResize(clampedExplorerSidebarWidth - 24);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        handleExplorerSidebarResize(clampedExplorerSidebarWidth + 24);
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        handleExplorerSidebarResize(DEFAULT_EXPLORER_SIDEBAR_WIDTH);
      }
    },
    [clampedExplorerSidebarWidth, handleExplorerSidebarResize, narrowWorkspaceLayout],
  );

  const workspaceLayoutStyle = useMemo(
    () =>
      narrowWorkspaceLayout
        ? undefined
        : {
            gridTemplateColumns: `${Math.round(clampedExplorerSidebarWidth)}px 12px minmax(0, 1fr)`,
          },
    [clampedExplorerSidebarWidth, narrowWorkspaceLayout],
  );

  return {
    clampedExplorerSidebarWidth,
    handleExplorerSidebarResize,
    handleExplorerResizeKeyDown,
    handleExplorerResizePointerDown,
    inspectorDrawerHeight,
    narrowWorkspaceLayout,
    setInspectorDrawerHeight,
    workspaceLayoutRef,
    workspaceLayoutStyle,
  };
}
