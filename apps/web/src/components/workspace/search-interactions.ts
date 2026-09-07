import { type ChordEvent, isCommandChord } from "./shortcuts";

/** ⌘K / Ctrl+K toggles the dock's search panel. Like the assistant's ⌘J, it
 * never steals the chord from a text field while the panel is closed (an
 * editor may bind it). Once search is open it toggles from anywhere, its own
 * input included — but from a text field only via ⌘: Ctrl+K in a macOS text
 * field is the native kill-to-end-of-line binding, which a person editing
 * their query may well be reaching for. */
export function shouldToggleSearchShortcut(
  event: ChordEvent,
  options: { searchOpen: boolean; editableTarget: boolean },
): boolean {
  if (!isCommandChord(event, "k")) return false;
  if (!options.editableTarget) return true;
  return options.searchOpen && event.metaKey;
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
