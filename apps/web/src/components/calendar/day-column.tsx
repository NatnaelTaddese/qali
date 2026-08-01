import { cn } from "@qali/ui/lib/utils";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { useAvailabilityEdit } from "@/components/workspace/availability-edit-context";
import type { Booking } from "@/components/workspace/booking-request-panel";
import { useDock } from "@/components/workspace/dock-context";

import { AvailabilityBlock } from "./availability-block";
import { BookingBlock } from "./booking-block";
import { EventCard } from "./event-card";
import { GhostEvent } from "./ghost-event";
import {
  layoutDayEvents,
  MS_PER_DAY,
  SNAP_MS,
  snappedMsFromOffsetY,
  type CalendarEvent,
} from "./lib";
import type { DragMode } from "./use-event-drag";

interface Draft {
  anchorMs: number;
  startMs: number;
  endMs: number;
  status: "armed" | "dragging";
}

const DRAG_THRESHOLD_PX = 4;

interface DayColumnProps {
  day: Date;
  events: CalendarEvent[];
  /** The shared `data-time-grid` element, read by card drags for geometry. */
  gridRef: RefObject<HTMLDivElement | null>;
  /** Start a move/resize gesture from a card. */
  beginDrag: (
    event: CalendarEvent,
    mode: DragMode,
    e: React.PointerEvent,
    gridEl: HTMLElement | null,
  ) => void;
  /** Id of the card currently being dragged, or null. */
  draggingId: string | null;
  /** Split overlaps into side-by-side columns (day view) vs. cascade (week). */
  laneLayout: boolean;
  /** Synced contact photos keyed by lower-cased email. */
  contactPhotos: ReadonlyMap<string, string>;
  /** Pending booking requests overlapping this day, in their own lane. */
  bookings: Booking[];
}

export function DayColumn({
  day,
  events,
  gridRef,
  beginDrag,
  draggingId,
  laneLayout,
  contactPhotos,
  bookings,
}: DayColumnProps) {
  const dayStartMs = day.getTime();
  const dayEndMs = dayStartMs + MS_PER_DAY;
  // A day whose last minute is already behind us can't be made available, so it
  // takes no paint and shows no availability blocks while editing.
  const dayIsPast = dayEndMs <= Date.now();
  const { view, open } = useDock();
  const { editing, intervalsForDay, addInterval, removeInterval } =
    useAvailabilityEdit();
  const ref = useRef<HTMLDivElement>(null);
  const pressClientY = useRef(0);
  const [draft, setDraft] = useState<Draft | null>(null);

  // A create awaiting confirmation in the dock keeps its ghost on whichever
  // column it falls in, and follows the times as they're edited there.
  const pendingRange =
    view?.kind === "create" && view.startMs < dayEndMs && view.endMs > dayStartMs
      ? view
      : null;

  const positioned = useMemo(
    () => layoutDayEvents(events, dayStartMs),
    [events, dayStartMs],
  );

  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDraft(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft]);

  const snappedMs = (clientY: number) => {
    const rect = ref.current?.getBoundingClientRect();
    const top = rect?.top ?? 0;
    const height = rect?.height ?? 1;
    return snappedMsFromOffsetY(clientY - top, dayStartMs, height);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Nothing to paint on a day that's already gone.
    if (editing && dayIsPast) return;
    // A pointer down on an existing availability block edits that block, so it
    // must never start a fresh selection.
    if ((e.target as HTMLElement).closest("[data-availability]")) return;
    // Outside edit mode, event cards run their own drag; while painting they are
    // inert context, so a selection may start on top of one.
    if (!editing && (e.target as HTMLElement).closest("[data-event]")) return;
    const anchorMs = Math.min(snappedMs(e.clientY), dayEndMs - SNAP_MS);
    pressClientY.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft({ anchorMs, startMs: anchorMs, endMs: anchorMs + SNAP_MS, status: "armed" });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draft) return;
    if (
      draft.status === "armed" &&
      Math.abs(e.clientY - pressClientY.current) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    const cursorMs = snappedMs(e.clientY);
    const startMs = Math.min(draft.anchorMs, cursorMs);
    const endMs = Math.min(
      Math.max(Math.max(draft.anchorMs, cursorMs), startMs + SNAP_MS),
      dayEndMs,
    );
    setDraft({ ...draft, startMs, endMs, status: "dragging" });
  };

  const onPointerUp = () => {
    if (!draft) return;
    // A plain click (never crossed the drag threshold) creates nothing.
    if (draft.status === "armed") {
      setDraft(null);
      return;
    }
    const { startMs, endMs } = draft;
    setDraft(null);
    // While painting availability, a selection commits straight to the day's
    // override — no dock, no confirm step.
    if (editing) {
      addInterval(day, startMs, endMs);
      return;
    }
    // Otherwise the drag only proposes a range — the dock takes it from here and
    // the user confirms. Hand the range over and drop the local draft; the ghost
    // that stays on the grid is now driven by the dock's create view.
    open({ kind: "create", startMs, endMs });
  };

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={cn(
        "relative border-l border-border",
        draft && "touch-none select-none",
      )}
      style={{ scrollSnapAlign: "start" }}
    >
      {/* While painting availability, events and requests drop back to inert
          context so a selection can start anywhere on the column. */}
      <div className={cn(editing && "pointer-events-none opacity-50")}>
        {positioned.map((p) => (
          <EventCard
            key={p.event._id}
            positioned={p}
            isDragging={draggingId === p.event._id}
            laneLayout={laneLayout}
            contactPhotos={contactPhotos}
            onDragStart={(mode, e) =>
              beginDrag(p.event, mode, e, gridRef.current)
            }
          />
        ))}
        {bookings.map((booking) => (
          <BookingBlock
            key={booking._id}
            booking={booking}
            dayStartMs={dayStartMs}
            onOpen={() => open({ kind: "booking", booking })}
          />
        ))}
      </div>
      {editing &&
        !dayIsPast &&
        intervalsForDay(day).intervals.map((interval, index) => (
          <AvailabilityBlock
            key={`${interval.startMin}-${interval.endMin}`}
            interval={interval}
            dayStartMs={dayStartMs}
            saving={interval.saving}
            onRemove={() => removeInterval(day, index)}
          />
        ))}
      {draft && draft.status === "dragging" && (
        <GhostEvent
          startMs={draft.startMs}
          endMs={draft.endMs}
          dayStartMs={dayStartMs}
          pending={false}
        />
      )}
      {pendingRange && (
        <GhostEvent
          startMs={pendingRange.startMs}
          endMs={pendingRange.endMs}
          dayStartMs={dayStartMs}
          pending
        />
      )}
    </div>
  );
}
