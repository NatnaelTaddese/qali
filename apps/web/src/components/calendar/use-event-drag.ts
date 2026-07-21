import { api } from "@qali/backend/convex/_generated/api";
import { useAction } from "convex/react";
import { startOfDay } from "date-fns";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useDock } from "@/components/workspace/dock-context";

import { type CalendarEvent, MS_PER_DAY, SNAP_MS } from "./lib";

/** How a card is being manipulated: relocated whole, or one edge dragged. */
export type DragMode = "move" | "resize-start" | "resize-end";

/** Pixels the pointer must travel before a press becomes a drag (below this a
 * press on a card is treated as a plain tap that opens it). */
const DRAG_THRESHOLD_PX = 4;

/** How long an optimistic override lingers after commit before we give up
 * waiting for the synced row to catch up and drop it anyway. */
const PENDING_TIMEOUT_MS = 10_000;

interface OverrideTimes {
  startMs: number;
  endMs: number;
}

/** Live, non-rendering state for the in-flight gesture. */
interface DragSession {
  event: CalendarEvent;
  mode: DragMode;
  gridEl: HTMLElement;
  el: HTMLElement;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  /** ms from the card's top edge to where it was grabbed (move only). */
  grabOffsetMs: number;
  durationMs: number;
  moved: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Snap an instant to the nearest 15-minute mark within its day. */
function snap(ms: number, dayStartMs: number): number {
  return dayStartMs + Math.round((ms - dayStartMs) / SNAP_MS) * SNAP_MS;
}

interface UseEventDrag {
  /** `events` with any live-drag or pending-save overrides applied. */
  effectiveEvents: CalendarEvent[];
  /** Start a drag from a card's pointerdown. `gridEl` is the `data-time-grid`. */
  beginDrag: (
    event: CalendarEvent,
    mode: DragMode,
    e: React.PointerEvent,
    gridEl: HTMLElement | null,
  ) => void;
  /** Id of the card currently being dragged, or null. */
  draggingId: string | null;
}

/**
 * Direct-manipulation drag/resize for timed event cards. A card reports its
 * pointerdown here; this tracks the pointer against the shared time-grid
 * geometry (so a move can cross day columns), snaps to the 15-minute grid, and
 * on drop persists via `updateEventTime`. Both the live preview and the
 * post-save hold are expressed as overrides on the events array, so the real
 * card re-lays-out and physically relocates with no bespoke positioning.
 */
export function useEventDrag(
  events: CalendarEvent[],
  days: Date[],
): UseEventDrag {
  const { open } = useDock();
  const updateEventTime = useAction(api.calendar.updateEventTime);

  const [overrides, setOverrides] = useState<Record<string, OverrideTimes>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const sessionRef = useRef<DragSession | null>(null);
  // Latest `days` for the move handler without re-binding window listeners.
  const daysRef = useRef(days);
  daysRef.current = days;
  // Ids whose override is a committed save awaiting the synced row (vs. a live
  // drag). Reconciled against incoming `events`.
  const pendingRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const effectiveEvents = useMemo(() => {
    if (Object.keys(overrides).length === 0) return events;
    return events.map((event) => {
      const o = overrides[event._id];
      return o ? { ...event, startMs: o.startMs, endMs: o.endMs } : event;
    });
  }, [events, overrides]);

  // Drop a pending override once the synced row reflects its times (or the row
  // vanished). Live-drag overrides (the active card) are left alone.
  useEffect(() => {
    if (pendingRef.current.size === 0) return;
    const byId = new Map<string, CalendarEvent>(events.map((e) => [e._id, e]));
    setOverrides((prev) => {
      let next = prev;
      for (const id of pendingRef.current) {
        const row = byId.get(id);
        const o = prev[id];
        if (!o) {
          pendingRef.current.delete(id);
          continue;
        }
        if (!row || (row.startMs === o.startMs && row.endMs === o.endMs)) {
          if (next === prev) next = { ...prev };
          delete next[id];
          pendingRef.current.delete(id);
          const t = timersRef.current.get(id);
          if (t) {
            clearTimeout(t);
            timersRef.current.delete(id);
          }
        }
      }
      return next;
    });
  }, [events]);

  // Clear any lingering timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const endSession = useCallback(() => {
    const s = sessionRef.current;
    if (s) {
      try {
        s.el.releasePointerCapture(s.pointerId);
      } catch {
        // Capture may never have been taken (tap) — ignore.
      }
    }
    sessionRef.current = null;
    setDraggingId(null);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerCancel = useCallback(
    (e: PointerEvent) => {
      const s = sessionRef.current;
      if (!s || e.pointerId !== s.pointerId) return;
      setOverrides((prev) => {
        if (!prev[s.event._id]) return prev;
        const next = { ...prev };
        delete next[s.event._id];
        return next;
      });
      endSession();
    },
    [endSession],
  );

  /** Compute the proposed times for the current pointer position. */
  const computeTimes = useCallback(
    (s: DragSession, clientX: number, clientY: number): OverrideTimes => {
      const rect = s.gridEl.getBoundingClientRect();
      const height = rect.height || 1;
      const msPerPx = MS_PER_DAY / height;
      const origStart = s.event.startMs;

      if (s.mode === "move") {
        const cols = daysRef.current.length;
        const colWidth = rect.width / cols;
        const idx = clamp(
          Math.floor((clientX - rect.left) / colWidth),
          0,
          cols - 1,
        );
        const dayStart = daysRef.current[idx].getTime();
        const dayEnd = dayStart + MS_PER_DAY;
        const rawPointer = dayStart + (clientY - rect.top) * msPerPx;
        const startMs = clamp(
          snap(rawPointer - s.grabOffsetMs, dayStart),
          dayStart,
          dayEnd - s.durationMs,
        );
        return { startMs, endMs: startMs + s.durationMs };
      }

      // Resize stays on the event's own day.
      const dayStart = startOfDay(new Date(origStart)).getTime();
      const dayEnd = dayStart + MS_PER_DAY;
      const rawPointer = dayStart + (clientY - rect.top) * msPerPx;
      const pointer = clamp(snap(rawPointer, dayStart), dayStart, dayEnd);
      if (s.mode === "resize-start") {
        const startMs = Math.min(pointer, s.event.endMs - SNAP_MS);
        return { startMs, endMs: s.event.endMs };
      }
      const endMs = Math.max(pointer, origStart + SNAP_MS);
      return { startMs: origStart, endMs };
    },
    [],
  );

  const commit = useCallback(
    (id: string, times: OverrideTimes) => {
      pendingRef.current.add(id);
      const existing = timersRef.current.get(id);
      if (existing) clearTimeout(existing);
      timersRef.current.set(
        id,
        setTimeout(() => {
          pendingRef.current.delete(id);
          timersRef.current.delete(id);
          setOverrides((prev) => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }, PENDING_TIMEOUT_MS),
      );
      updateEventTime({
        eventId: id as CalendarEvent["_id"],
        startMs: times.startMs,
        endMs: times.endMs,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }).catch((error: unknown) => {
        // Roll the card back to its synced position and surface the failure.
        pendingRef.current.delete(id);
        const t = timersRef.current.get(id);
        if (t) {
          clearTimeout(t);
          timersRef.current.delete(id);
        }
        setOverrides((prev) => {
          if (!prev[id]) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        toast.error("Couldn't reschedule event", {
          description: error instanceof Error ? error.message : undefined,
        });
      });
    },
    [updateEventTime],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const s = sessionRef.current;
      if (!s || e.pointerId !== s.pointerId) return;
      if (!s.moved) {
        if (
          Math.abs(e.clientX - s.startClientX) < DRAG_THRESHOLD_PX &&
          Math.abs(e.clientY - s.startClientY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        s.moved = true;
        try {
          s.el.setPointerCapture(s.pointerId);
        } catch {
          // Non-fatal: window listeners still deliver moves.
        }
        setDraggingId(s.event._id);
      }
      const times = computeTimes(s, e.clientX, e.clientY);
      setOverrides((prev) => ({ ...prev, [s.event._id]: times }));
    },
    [computeTimes],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const s = sessionRef.current;
      if (!s || e.pointerId !== s.pointerId) return;
      if (!s.moved) {
        // A press that never became a drag — anywhere on the card, edges
        // included — opens the event.
        open({ kind: "event", event: s.event });
        endSession();
        return;
      }
      const times = computeTimes(s, e.clientX, e.clientY);
      const id = s.event._id;
      const unchanged =
        times.startMs === s.event.startMs && times.endMs === s.event.endMs;
      if (unchanged) {
        setOverrides((prev) => {
          if (!prev[id]) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } else {
        setOverrides((prev) => ({ ...prev, [id]: times }));
        commit(id, times);
      }
      endSession();
    },
    [computeTimes, commit, open, endSession],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const s = sessionRef.current;
      if (!s) return;
      setOverrides((prev) => {
        if (!prev[s.event._id]) return prev;
        const next = { ...prev };
        delete next[s.event._id];
        return next;
      });
      endSession();
    },
    [endSession],
  );

  const beginDrag = useCallback(
    (
      event: CalendarEvent,
      mode: DragMode,
      e: React.PointerEvent,
      gridEl: HTMLElement | null,
    ) => {
      if (e.button !== 0 || !gridEl) return;
      const cardRect = e.currentTarget.getBoundingClientRect();
      const gridRect = gridEl.getBoundingClientRect();
      const msPerPx = MS_PER_DAY / (gridRect.height || 1);
      sessionRef.current = {
        event,
        mode,
        gridEl,
        el: e.currentTarget as HTMLElement,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        grabOffsetMs: (e.clientY - cardRect.top) * msPerPx,
        durationMs: Math.max(event.endMs - event.startMs, SNAP_MS),
        moved: false,
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("keydown", onKeyDown);
    },
    [onPointerMove, onPointerUp, onPointerCancel, onKeyDown],
  );

  return { effectiveEvents, beginDrag, draggingId };
}
