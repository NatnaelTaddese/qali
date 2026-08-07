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
    event.key.toLowerCase() === "j"
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

function eventIdOf(input: unknown): string | null {
  if (input && typeof input === "object" && "eventId" in input) {
    const id = (input as { eventId?: unknown }).eventId;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/** The start instant of a proposal's `time` argument, when it's a timed range.
 * All-day ranges (calendar dates) and absent times return undefined — the
 * reveal then flashes without a vertical scroll. */
function timedStartMs(input: unknown): number | undefined {
  if (!input || typeof input !== "object" || !("time" in input)) return undefined;
  const time = (input as { time?: unknown }).time;
  if (
    time &&
    typeof time === "object" &&
    (time as { kind?: unknown }).kind === "timed"
  ) {
    const startMs = (time as { startMs?: unknown }).startMs;
    return typeof startMs === "number" ? startMs : undefined;
  }
  return undefined;
}

/** Where the calendar should scroll and what it should pulse once an assistant
 * proposal is applied. Returns null when there is nothing to reveal (a deletion,
 * or a booking decision). `input` is the stored tool-argument JSON.
 *
 * - create_event: no id yet, so flash by `operationId` — Google's client-chosen
 *   id, which is what the event syncs back in as (`googleEventId`).
 * - move_event / update_event: flash by `eventId` (the Convex `_id`); a change
 *   with no new time still pulses the card in place. */
export function revealTargetForAction(action: {
  tool: string;
  input: string;
  operationId?: string;
}): { startMs?: number; flashId: string } | null {
  let input: unknown;
  try {
    input = JSON.parse(action.input);
  } catch {
    return null;
  }
  const startMs = timedStartMs(input);
  const withStart = (flashId: string) =>
    startMs != null ? { flashId, startMs } : { flashId };

  switch (action.tool) {
    case "create_event":
      return action.operationId ? withStart(action.operationId) : null;
    case "move_event":
    case "update_event": {
      const eventId = eventIdOf(input);
      return eventId ? withStart(eventId) : null;
    }
    default:
      // delete_event / decide_booking_request: nothing to reach for.
      return null;
  }
}

export function acknowledgedAssistantUserMessageId<T extends string>(
  messages:
    | readonly {
        _id: T;
        role: string;
        blocks: readonly { type: string; text?: string }[];
      }[]
    | undefined,
  previousUserMessageId: T | null,
  pendingText: string,
): T | null {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages?.[index];
    if (message?.role !== "user") continue;
    const text = message.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    return message._id !== previousUserMessageId && text === pendingText
      ? message._id
      : null;
  }
  return null;
}
