import { cn } from "@qali/ui/lib/utils";
import { addDays, format, isToday } from "date-fns";
import { memo, type RefObject, useCallback, useMemo, useState } from "react";

import { useAvailabilityEdit } from "@/components/workspace/availability-edit-context";
import type { Booking } from "@/components/workspace/booking-request-panel";
import { useDock } from "@/components/workspace/dock-context";

import { AvailabilityBlock } from "./availability-block";
import { BookingBlock } from "./booking-block";
import { EventCard } from "./event-card";
import { GhostEvent } from "./ghost-event";
import type { GridDragMode, GridDragRange } from "./grid-drag";
import {
  LANE_TILE_MAX_STAGGER_MS,
  layoutDayEvents,
  MS_PER_DAY,
  MS_PER_MINUTE,
  SNAP_MINUTES,
  WEEK_LANE_TILE_MAX_STAGGER_MS,
  type CalendarEvent,
} from "./lib";
import type { Reveal } from "./today-pulse";
import type { DragMode } from "./use-event-drag";
import { useGridDrag } from "./use-grid-drag";

interface KeyboardDraft {
  startMin: number;
  endMin: number;
}

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
  /** The active reveal target; pulses the matching event card or request block. */
  reveal: Reveal;
}

function DayColumnImpl({
  day,
  events,
  gridRef,
  beginDrag,
  draggingId,
  laneLayout,
  contactPhotos,
  bookings,
  reveal,
}: DayColumnProps) {
  const dayStartMs = day.getTime();
  const dayEndMs = dayStartMs + MS_PER_DAY;
  // A day whose last minute is already behind us can't be made available, so it
  // takes no paint and shows no availability blocks while editing.
  const dayIsPast = addDays(day, 1).getTime() <= Date.now();
  const { view, open } = useDock();
  const {
    editing,
    ready,
    intervalsForDay,
    addInterval,
    removeInterval,
    resetDay,
  } = useAvailabilityEdit();
  const [keyboardDraft, setKeyboardDraft] = useState<KeyboardDraft>({
    startMin: 9 * 60,
    endMin: 9 * 60 + SNAP_MINUTES,
  });
  const [keyboardActive, setKeyboardActive] = useState(false);
  const canEditDay = editing && ready && !dayIsPast;
  const availability = canEditDay ? intervalsForDay(day) : null;

  // A create awaiting confirmation in the dock keeps its ghost on whichever
  // column it falls in, and follows the times as they're edited there.
  const pendingRange =
    view?.kind === "create" && view.startMs < dayEndMs && view.endMs > dayStartMs
      ? view
      : null;

  // Week columns cascade and tile more eagerly than the wider day column; the
  // threshold that flips a close-starting overlap from cascade to side-by-side
  // tiles follows the same laneLayout switch used for rendering.
  const tileMaxStaggerMs = laneLayout
    ? LANE_TILE_MAX_STAGGER_MS
    : WEEK_LANE_TILE_MAX_STAGGER_MS;
  const positioned = useMemo(
    () => layoutDayEvents(events, dayStartMs, tileMaxStaggerMs),
    [events, dayStartMs, tileMaxStaggerMs],
  );

  // One gesture serves both features; which one it is gets fixed at pointerdown
  // and read back here, so leaving edit mode mid-drag can't reroute a selection
  // into the other branch.
  const { preview, begin } = useGridDrag(
    useCallback(
      (mode: GridDragMode, range: GridDragRange) => {
        // While painting availability, a selection commits straight to the
        // day's override — no dock, no confirm step.
        if (mode === "paint") {
          addInterval(day, range.startMs, range.endMs);
          return;
        }
        // Otherwise the drag only proposes a range — the dock takes it from
        // here and the user confirms.
        open({ kind: "create", startMs: range.startMs, endMs: range.endMs });
      },
      [addInterval, day, open],
    ),
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Nothing to paint on a day that's already gone.
    if (editing && !canEditDay) return;
    // A pointer down on an existing availability block edits that block, so it
    // must never start a fresh selection.
    if ((e.target as HTMLElement).closest("[data-availability]")) return;
    // Outside edit mode, event cards run their own drag; while painting they are
    // inert context, so a selection may start on top of one.
    if (!editing && (e.target as HTMLElement).closest("[data-event]")) return;
    if (editing) setKeyboardActive(false);
    begin({
      mode: editing ? "paint" : "create",
      dayStartMs,
      columnEl: e.currentTarget,
      e,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canEditDay || e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      addInterval(
        day,
        dayStartMs + keyboardDraft.startMin * MS_PER_MINUTE,
        dayStartMs + keyboardDraft.endMin * MS_PER_MINUTE,
      );
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const delta = e.key === "ArrowUp" ? -SNAP_MINUTES : SNAP_MINUTES;
    setKeyboardDraft((current) => {
      if (e.shiftKey) {
        return {
          ...current,
          endMin: Math.min(
            24 * 60,
            Math.max(current.startMin + SNAP_MINUTES, current.endMin + delta),
          ),
        };
      }
      const duration = current.endMin - current.startMin;
      const startMin = Math.min(
        24 * 60 - duration,
        Math.max(0, current.startMin + delta),
      );
      return { startMin, endMin: startMin + duration };
    });
  };

  return (
    <div
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget) setKeyboardActive(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setKeyboardActive(false);
      }}
      tabIndex={canEditDay ? 0 : undefined}
      role={canEditDay ? "group" : undefined}
      aria-keyshortcuts={canEditDay ? "ArrowUp ArrowDown Enter" : undefined}
      aria-label={
        canEditDay
          ? `Add availability on ${format(day, "EEEE, MMMM d")}. Arrow keys move the selection, Shift plus arrow changes its duration, and Enter adds it.`
          : undefined
      }
      className={cn(
        // `touch-action` has to be settled *before* the pointer goes down — the
        // browser latches it at that moment, so a class applied once a drag
        // exists lands a render too late and the scroller wins the gesture.
        // While painting, a vertical drag is always a paint; otherwise the
        // strip keeps its own scrolling and paging.
        "relative border-l border-border select-none",
        canEditDay && "touch-none",
      )}
      style={{
        scrollSnapAlign: "start",
        // Subtle tint on today's column (matching the marketing week view) that
        // fades to transparent toward the bottom rather than ending on a hard edge.
        ...(isToday(day) && {
          backgroundImage:
            "linear-gradient(to bottom, color-mix(in oklab, var(--primary) 3%, transparent) 0%, color-mix(in oklab, var(--primary) 3%, transparent) 75%, transparent 100%)",
        }),
      }}
    >
      {/* While painting availability, events and requests drop back to inert
          context so a selection can start anywhere on the column. */}
      <div
        inert={editing ? true : undefined}
        className={cn(editing && "pointer-events-none opacity-50")}
      >
        {positioned.map((p) => (
          <EventCard
            key={p.event._id}
            positioned={p}
            isDragging={draggingId === p.event._id}
            laneLayout={laneLayout}
            contactPhotos={contactPhotos}
            reveal={reveal}
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
            reveal={reveal}
            onOpen={() => open({ kind: "booking", booking })}
          />
        ))}
      </div>
      {availability?.isOverride && (
        <button
          type="button"
          data-availability
          onClick={() => resetDay(day)}
          className="absolute top-1 right-1 z-40 rounded-md bg-background/90 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Use weekly
        </button>
      )}
      {availability?.intervals.map((interval, index) => (
        <AvailabilityBlock
          key={`${interval.startMin}-${interval.endMin}`}
          interval={interval}
          dayStartMs={dayStartMs}
          saving={interval.saving}
          onRemove={() => removeInterval(day, index)}
        />
      ))}
      {preview && (
        <GhostEvent
          startMs={preview.startMs}
          endMs={preview.endMs}
          dayStartMs={dayStartMs}
          pending={false}
          wallClock={preview.mode === "paint"}
          variant={preview.mode}
        />
      )}
      {canEditDay && keyboardActive && !preview && (
        <GhostEvent
          startMs={dayStartMs + keyboardDraft.startMin * MS_PER_MINUTE}
          endMs={dayStartMs + keyboardDraft.endMin * MS_PER_MINUTE}
          dayStartMs={dayStartMs}
          pending={false}
          wallClock
          variant="paint"
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

/**
 * A strip renders dozens of these at once and scrolling re-renders the strip
 * on every animation frame, so memoization is what keeps a gesture cheap.
 * It only holds while every prop keeps its identity — in particular the
 * `?? []` query fallbacks in time-strip.tsx must stay hoisted to module
 * constants, or each render mints new arrays and this becomes a no-op.
 */
export const DayColumn = memo(DayColumnImpl);
