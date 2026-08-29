import { useCallback, useEffect, useRef, useState } from "react";

import {
  advance,
  beginSession,
  commitRange,
  type GridDragMode,
  type GridDragRange,
  type GridDragSession,
  ownsPointer,
} from "./grid-drag";

/** The live selection a column should draw while a gesture is in flight. */
export interface GridDragPreview extends GridDragRange {
  mode: GridDragMode;
}

export interface BeginGridDragOptions {
  /** Latched for the whole gesture — see {@link GridDragMode}. */
  mode: GridDragMode;
  dayStartMs: number;
  /** The column the gesture is anchored to; measured once, and the element that
   * takes pointer capture if the press becomes a drag. */
  columnEl: HTMLElement;
  e: React.PointerEvent;
}

export interface UseGridDrag {
  /** The range to draw, or `null` when nothing is in flight. */
  preview: GridDragPreview | null;
  /** Open a gesture from a column's pointerdown. */
  begin: (options: BeginGridDragOptions) => void;
}

/**
 * The one drag gesture the time grid runs on empty space: sweep a range to
 * propose a new event, or — while painting availability — to open a span.
 *
 * Both features share the mechanics but not the outcome, so the mode is latched
 * at pointerdown and handed back at commit; nothing downstream re-reads the
 * live edit flag. Movement is tracked on `window` rather than the column, with
 * pointer capture taken only once the press has become a real drag, so a tap or
 * a scroll is never owned by the grid.
 *
 * Cancellation is explicit. When the browser takes the pointer away — a strip
 * scroll on touch, a system gesture — `pointercancel` fires and no `pointerup`
 * ever follows. Without handling it the selection would draw, commit nothing,
 * and leave live state behind for the *next* release on that column to commit
 * in whatever mode was active by then.
 */
export function useGridDrag(
  onCommit: (mode: GridDragMode, range: GridDragRange) => void,
): UseGridDrag {
  const [preview, setPreview] = useState<GridDragPreview | null>(null);
  const sessionRef = useRef<GridDragSession | null>(null);
  const elRef = useRef<HTMLElement | null>(null);
  // The listeners below are bound once and must stay identity-stable to come
  // off again, so the commit callback is reached through a ref.
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  });

  const endSession = useCallback(() => {
    const session = sessionRef.current;
    const el = elRef.current;
    if (session && el) {
      try {
        el.releasePointerCapture(session.pointerId);
      } catch {
        // Capture may never have been taken (a press that stayed a press).
      }
    }
    sessionRef.current = null;
    elRef.current = null;
    setPreview(null);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const session = sessionRef.current;
    if (!ownsPointer(session, e.pointerId)) return;
    const wasMoved = session.moved;
    const range = advance(session, e.clientX, e.clientY);
    if (!range) return;
    if (!wasMoved) {
      try {
        elRef.current?.setPointerCapture(session.pointerId);
      } catch {
        // Non-fatal: the window listeners still deliver the rest of the drag.
      }
    }
    setPreview({ mode: session.mode, ...range });
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const session = sessionRef.current;
      if (!ownsPointer(session, e.pointerId)) return;
      const range = commitRange(session);
      const mode = session.mode;
      endSession();
      if (range) commitRef.current(mode, range);
    },
    [endSession],
  );

  const onPointerCancel = useCallback(
    (e: PointerEvent) => {
      const session = sessionRef.current;
      if (!ownsPointer(session, e.pointerId)) return;
      // The pointer was taken from us; there is no range to trust and no
      // pointerup coming. Drop everything.
      endSession();
    },
    [endSession],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!sessionRef.current) return;
      endSession();
    },
    [endSession],
  );

  const begin = useCallback(
    ({ mode, dayStartMs, columnEl, e }: BeginGridDragOptions) => {
      if (e.button !== 0) return;
      // A second pointer never joins a gesture already in flight.
      if (sessionRef.current) return;
      const rect = columnEl.getBoundingClientRect();
      sessionRef.current = beginSession({
        pointerId: e.pointerId,
        mode,
        dayStartMs,
        columnTop: rect.top,
        columnHeight: rect.height,
        clientX: e.clientX,
        clientY: e.clientY,
      });
      elRef.current = columnEl;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("keydown", onKeyDown);
    },
    [onPointerMove, onPointerUp, onPointerCancel, onKeyDown],
  );

  // A column can unmount mid-drag (the strip pages, the view switches); its
  // window listeners must not outlive it.
  useEffect(() => endSession, [endSession]);

  return { preview, begin };
}
