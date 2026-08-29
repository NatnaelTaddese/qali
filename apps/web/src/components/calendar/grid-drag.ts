import { MS_PER_DAY, SNAP_MS, snappedMsFromOffsetY } from "./lib";

/**
 * Which feature a grid drag belongs to. Latched when the gesture starts and
 * never re-read: a selection that began while painting availability must commit
 * as a paint even if edit mode is left mid-drag, and a plain drag-create must
 * never turn into a paint because the mode flipped under it.
 */
export type GridDragMode = "create" | "paint";

/** Pixels the pointer must travel, on either axis, before a press becomes a
 * drag. Below this the press is a plain click and commits nothing. Horizontal
 * travel counts too, so a sideways page swipe never arms a selection. */
export const GRID_DRAG_THRESHOLD_PX = 4;

export interface GridDragRange {
  startMs: number;
  endMs: number;
}

/**
 * Live, non-rendering state for an in-flight grid gesture.
 *
 * Column geometry is measured once, at pointerdown. The column can move under
 * the pointer mid-drag — focusing it scrolls the snap scroller it lives in, and
 * a resize relays the grid — and re-measuring per move would shift the
 * pixel-to-time mapping halfway through a selection.
 */
export interface GridDragSession extends GridDragRange {
  pointerId: number;
  mode: GridDragMode;
  dayStartMs: number;
  dayEndMs: number;
  columnTop: number;
  columnHeight: number;
  anchorMs: number;
  startClientX: number;
  startClientY: number;
  /** True once the threshold was crossed. Only a moved session commits. */
  moved: boolean;
}

export interface BeginSessionInput {
  pointerId: number;
  mode: GridDragMode;
  dayStartMs: number;
  columnTop: number;
  columnHeight: number;
  clientX: number;
  clientY: number;
}

/** Open a session anchored at the pressed time. The anchor is held one snap
 * step clear of midnight so a selection started at the very bottom of the
 * column still has room to be a real range. */
export function beginSession({
  pointerId,
  mode,
  dayStartMs,
  columnTop,
  columnHeight,
  clientX,
  clientY,
}: BeginSessionInput): GridDragSession {
  const dayEndMs = dayStartMs + MS_PER_DAY;
  // A zero-height column would divide by zero in the snap; 1px keeps the
  // mapping finite and the result clamped inside the day.
  const height = columnHeight || 1;
  const anchorMs = Math.min(
    snappedMsFromOffsetY(clientY - columnTop, dayStartMs, height),
    dayEndMs - SNAP_MS,
  );
  return {
    pointerId,
    mode,
    dayStartMs,
    dayEndMs,
    columnTop,
    columnHeight: height,
    anchorMs,
    startClientX: clientX,
    startClientY: clientY,
    moved: false,
    startMs: anchorMs,
    endMs: anchorMs + SNAP_MS,
  };
}

/**
 * Fold a pointer position into the session, promoting it to a real drag once
 * the threshold is crossed. Returns the range to draw, or `null` while the
 * press is still just a press.
 *
 * Mutates `session` — it is live gesture state held in a ref, not React state.
 */
export function advance(
  session: GridDragSession,
  clientX: number,
  clientY: number,
): GridDragRange | null {
  if (!session.moved) {
    if (
      Math.abs(clientX - session.startClientX) < GRID_DRAG_THRESHOLD_PX &&
      Math.abs(clientY - session.startClientY) < GRID_DRAG_THRESHOLD_PX
    ) {
      return null;
    }
    session.moved = true;
  }
  const cursorMs = snappedMsFromOffsetY(
    clientY - session.columnTop,
    session.dayStartMs,
    session.columnHeight,
  );
  const startMs = Math.min(session.anchorMs, cursorMs);
  const endMs = Math.min(
    Math.max(Math.max(session.anchorMs, cursorMs), startMs + SNAP_MS),
    session.dayEndMs,
  );
  session.startMs = startMs;
  session.endMs = endMs;
  return { startMs, endMs };
}

/** The range a finished session should commit, or `null` when it never became
 * a drag (a plain click creates nothing) or collapsed to no duration. */
export function commitRange(session: GridDragSession): GridDragRange | null {
  if (!session.moved) return null;
  if (session.endMs <= session.startMs) return null;
  return { startMs: session.startMs, endMs: session.endMs };
}

/** Whether `pointerId` is the pointer that opened `session`. A second finger or
 * a pen alongside a held button must never steer someone else's gesture. */
export function ownsPointer(
  session: GridDragSession | null,
  pointerId: number,
): session is GridDragSession {
  return session !== null && session.pointerId === pointerId;
}
