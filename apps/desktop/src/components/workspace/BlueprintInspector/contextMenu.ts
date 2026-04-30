import {
  copyToClipboard,
  systemFileExplorerLabel,
  type AppContextMenuItem,
} from "../../shared/AppContextMenu";

export function buildInspectorContextMenuItems({
  canEditInline,
  dirty,
  draftStale,
  hasRevealedSource,
  inspectorTitle,
  isSavingSource,
  nodePath,
  onCancelSource,
  onClose,
  onDismissSource,
  onOpenNodeInDefaultEditor,
  onRevealNodeInFileExplorer,
  onSaveSource,
  selectedText,
  symbolQualname,
  targetId,
}: {
  canEditInline: boolean;
  dirty: boolean;
  draftStale?: boolean;
  hasRevealedSource: boolean;
  inspectorTitle: string;
  isSavingSource: boolean;
  nodePath?: string;
  onCancelSource: () => void;
  onClose: () => void;
  onDismissSource: () => void;
  onOpenNodeInDefaultEditor?: (targetId: string) => void | Promise<void>;
  onRevealNodeInFileExplorer?: (targetId: string) => void | Promise<void>;
  onSaveSource: () => void | Promise<void>;
  selectedText: string;
  symbolQualname?: string;
  targetId?: string;
}): AppContextMenuItem[] {
  const items: AppContextMenuItem[] = [];

  if (targetId && onRevealNodeInFileExplorer) {
    items.push({
      id: "reveal-node",
      label: systemFileExplorerLabel(),
      action: () => onRevealNodeInFileExplorer(targetId),
    });
  }

  if (targetId && onOpenNodeInDefaultEditor) {
    items.push({
      id: "open-default",
      label: "Open in Default Editor",
      action: () => onOpenNodeInDefaultEditor(targetId),
    });
  }

  if (canEditInline) {
    items.push(
      {
        id: "save-source",
        label: isSavingSource ? "Saving..." : "Save Source",
        action: onSaveSource,
        disabled: Boolean(draftStale) || !dirty || isSavingSource,
        separatorBefore: items.length > 0,
      },
      {
        id: "cancel-source",
        label: draftStale ? "Reload from Disk" : "Cancel Source Changes",
        action: onCancelSource,
        disabled: (!dirty && !draftStale) || isSavingSource,
      },
    );
  }

  if (selectedText) {
    items.push({
      id: "copy-selection",
      label: "Copy Selection",
      action: () => copyToClipboard(selectedText),
      separatorBefore: true,
    });
  }

  if (nodePath) {
    items.push({
      id: "copy-path",
      label: "Copy Path",
      action: () => copyToClipboard(nodePath),
      separatorBefore: !selectedText,
    });
  }

  if (inspectorTitle) {
    items.push({
      id: "copy-title",
      label: "Copy Title",
      action: () => copyToClipboard(inspectorTitle),
    });
  }

  if (targetId) {
    items.push({
      id: "copy-target-id",
      label: "Copy Target ID",
      action: () => copyToClipboard(targetId),
    });
  }

  if (symbolQualname) {
    items.push({
      id: "copy-qualname",
      label: "Copy Qualified Name",
      action: () => copyToClipboard(symbolQualname),
    });
  }

  if (hasRevealedSource) {
    items.push({
      id: "hide-revealed-source",
      label: "Hide Revealed Source",
      action: onDismissSource,
      separatorBefore: true,
    });
  }

  items.push({
    id: "close-inspector",
    label: "Collapse Inspector",
    action: onClose,
    separatorBefore: true,
  });

  return items;
}
