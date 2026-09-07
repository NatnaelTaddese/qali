/** Shared pieces of the app's keyboard chords (⌘J assistant, ⌘K search), so
 * each chord composes the same test instead of copying it. */

export type ChordEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "defaultPrevented"
> & { altKey?: boolean };

/** ⌘<letter> or Ctrl+<letter>, unconsumed, with no Alt (Alt chords type
 * characters on some layouts). */
export function isCommandChord(event: ChordEvent, letter: string): boolean {
  return (
    !event.defaultPrevented &&
    !event.altKey &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === letter
  );
}

/** A text field or editor: chords are left alone there while the panel that
 * owns them is closed, since an editor may bind the chord itself. */
export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}
