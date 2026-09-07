/** ⌘K / Ctrl+K toggles the dock's search panel. Mirrors the assistant's ⌘J
 * rule: never steal the chord from a text field while the panel is closed
 * (an editor may bind it), but once search is open it toggles from anywhere,
 * its own input included. */
export function shouldToggleSearchShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "defaultPrevented"
  >,
  options: { searchOpen: boolean; editableTarget: boolean },
): boolean {
  return (
    !event.defaultPrevented &&
    !event.altKey &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "k" &&
    (options.searchOpen || !options.editableTarget)
  );
}

/** Where the highlighted result lands after an arrow key. Wraps at both ends
 * so the list feels like a ring; a list with nothing in it stays at 0. */
export function stepActiveResult(
  active: number,
  count: number,
  delta: 1 | -1,
): number {
  if (count === 0) return 0;
  return (active + delta + count) % count;
}
