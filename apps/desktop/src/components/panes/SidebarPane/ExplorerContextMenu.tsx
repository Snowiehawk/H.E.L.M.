import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { ExplorerContextMenuItem, ExplorerContextMenuState, ExplorerTreeNode } from "./types";

export function ExplorerContextMenu({
  contextMenu,
  contextMenuItems,
  contextMenuRef,
  contextRow,
  onClose,
  onKeyDown,
  onRunItem,
}: {
  contextMenu: ExplorerContextMenuState;
  contextMenuItems: ExplorerContextMenuItem[];
  contextMenuRef: RefObject<HTMLDivElement>;
  contextRow: ExplorerTreeNode;
  onClose: (restoreFocus?: boolean) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onRunItem: (item: ExplorerContextMenuItem) => void | Promise<void>;
}) {
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
        ref={contextMenuRef}
        aria-label={`${contextRow.label} actions`}
        className="explorer-context-menu"
        role="menu"
        style={{
          left: contextMenu.x,
          top: contextMenu.y,
        }}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {contextMenuItems.map((item) => (
          <div key={item.id} role="none">
            {item.separatorBefore ? (
              <div className="context-menu__separator" role="separator" />
            ) : null}
            <button
              className="context-menu__item"
              role="menuitem"
              type="button"
              onClick={() => {
                void onRunItem(item);
              }}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
