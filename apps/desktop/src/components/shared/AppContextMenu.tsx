import { useEffect, useRef } from "react";

export interface AppContextMenuItem {
  id: string;
  label: string;
  action: () => void | Promise<void>;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export interface AppContextMenuPosition {
  x: number;
  y: number;
}

const APP_CONTEXT_MENU_WIDTH = 248;
const APP_CONTEXT_MENU_MAX_HEIGHT = 336;
const APP_CONTEXT_MENU_MARGIN = 8;

export function clampAppContextMenuPosition(x: number, y: number): AppContextMenuPosition {
  const viewportWidth = window.innerWidth || APP_CONTEXT_MENU_WIDTH + APP_CONTEXT_MENU_MARGIN * 2;
  const viewportHeight =
    window.innerHeight || APP_CONTEXT_MENU_MAX_HEIGHT + APP_CONTEXT_MENU_MARGIN * 2;
  return {
    x: Math.max(
      APP_CONTEXT_MENU_MARGIN,
      Math.min(x, viewportWidth - APP_CONTEXT_MENU_WIDTH - APP_CONTEXT_MENU_MARGIN),
    ),
    y: Math.max(
      APP_CONTEXT_MENU_MARGIN,
      Math.min(y, viewportHeight - APP_CONTEXT_MENU_MAX_HEIGHT - APP_CONTEXT_MENU_MARGIN),
    ),
  };
}

export async function copyToClipboard(value: string) {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable in this window.");
  }

  await navigator.clipboard.writeText(value);
}

export function contextActionError(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

export function systemFileExplorerLabel() {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) {
    return "Show in Finder";
  }
  if (platform.includes("win")) {
    return "Show in File Explorer";
  }
  return "Show in File Manager";
}

export function AppContextMenu({
  label,
  items,
  position,
  onClose,
  onActionError,
}: {
  label: string;
  items: AppContextMenuItem[];
  position: AppContextMenuPosition;
  onClose: (restoreFocus?: boolean) => void;
  onActionError?: (message: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const enabledItems = items.filter((item) => !item.disabled);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [position.x, position.y]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  const runItem = async (item: AppContextMenuItem) => {
    if (item.disabled) {
      return;
    }

    onClose();
    try {
      await item.action();
    } catch (reason) {
      onActionError?.(contextActionError(reason, `Unable to run ${item.label.toLowerCase()}.`));
    }
  };

  return (
    <div
      aria-hidden="false"
      className="context-menu-layer"
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={() => onClose()}
    >
      <div
        ref={menuRef}
        aria-label={label}
        className="app-context-menu"
        role="menu"
        style={{
          left: position.x,
          top: position.y,
        }}
        onKeyDown={(event) => {
          const focusableItems = Array.from(
            menuRef.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
            ) ?? [],
          );
          const currentIndex = focusableItems.indexOf(document.activeElement as HTMLButtonElement);

          switch (event.key) {
            case "ArrowDown":
              event.preventDefault();
              focusableItems[
                (currentIndex + 1 + focusableItems.length) % focusableItems.length
              ]?.focus();
              break;
            case "ArrowUp":
              event.preventDefault();
              focusableItems[
                (currentIndex - 1 + focusableItems.length) % focusableItems.length
              ]?.focus();
              break;
            case "Home":
              event.preventDefault();
              focusableItems[0]?.focus();
              break;
            case "End":
              event.preventDefault();
              focusableItems[focusableItems.length - 1]?.focus();
              break;
            case "Escape":
              event.preventDefault();
              onClose(true);
              break;
            default:
              break;
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <div key={item.id} role="none">
            {item.separatorBefore ? (
              <div className="context-menu__separator" role="separator" />
            ) : null}
            <button
              className="context-menu__item"
              disabled={item.disabled}
              role="menuitem"
              type="button"
              onClick={() => {
                void runItem(item);
              }}
            >
              {item.label}
            </button>
          </div>
        ))}
        {!enabledItems.length ? (
          <div className="context-menu__empty">No actions available</div>
        ) : null}
      </div>
    </div>
  );
}
