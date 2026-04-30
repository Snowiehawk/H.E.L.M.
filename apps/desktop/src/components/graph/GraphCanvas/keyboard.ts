export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const editableHost = target.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
  );
  return editableHost instanceof HTMLElement;
}

export function shouldHandleRerouteDeleteKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    (event.key !== "Backspace" && event.key !== "Delete") ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableEventTarget(event.target)
  );
}

export function shouldHandlePinKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key.toLowerCase() !== "p" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    isEditableEventTarget(event.target)
  );
}

export function shouldHandleCreateModeKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key.toLowerCase() !== "c" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableEventTarget(event.target)
  );
}

export function shouldHandleFitViewKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key.toLowerCase() !== "f" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableEventTarget(event.target)
  );
}

export function shouldHandleGroupKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key.toLowerCase() !== "g" ||
    event.altKey ||
    !(event.ctrlKey || event.metaKey) ||
    event.shiftKey ||
    isEditableEventTarget(event.target)
  );
}

export function shouldHandleUngroupKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key.toLowerCase() !== "g" ||
    event.altKey ||
    !(event.ctrlKey || event.metaKey) ||
    !event.shiftKey ||
    isEditableEventTarget(event.target)
  );
}
