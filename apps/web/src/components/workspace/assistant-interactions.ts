const SCROLL_FOLLOW_THRESHOLD_PX = 48;

export function isNearScrollBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
  return scrollHeight - scrollTop - clientHeight <= SCROLL_FOLLOW_THRESHOLD_PX;
}

export function shouldSendAssistantMessage({
  key,
  shiftKey,
  isComposing,
}: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean {
  return key === "Enter" && !shiftKey && !isComposing;
}

export function shouldOpenAssistantShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "defaultPrevented"
  >,
  options: { blocked: boolean; editableTarget: boolean },
): boolean {
  return (
    !event.defaultPrevented &&
    !options.blocked &&
    !options.editableTarget &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "k"
  );
}

export function isEditableAssistantShortcutTarget(
  target: EventTarget | null,
): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}

export function safeAssistantLink(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}
