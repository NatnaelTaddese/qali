import { cn } from "@qali/ui/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";

import { useDock } from "@/components/workspace/dock-context";

import { EventCard } from "./event-card";
import { GhostEvent } from "./ghost-event";
import {
  layoutDayEvents,
  MS_PER_DAY,
  SNAP_MS,
  snappedMsFromOffsetY,
  type CalendarEvent,
} from "./lib";

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
  /** Mark this column as a horizontal scroll-snap target. */
  snapAlign?: boolean;
}

export function DayColumn({ day, events, snapAlign }: DayColumnProps) {
  const dayStartMs = day.getTime();
  const dayEndMs = dayStartMs + MS_PER_DAY;
  const { view, open } = useDock();
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
    if ((e.target as HTMLElement).closest("[data-event]")) return;
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
    // The drag only proposes a range — the dock takes it from here and the user
    // confirms. Hand the range over and drop the local draft; the ghost that
    // stays on the grid is now driven by the dock's create view.
    const { startMs, endMs } = draft;
    setDraft(null);
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
      style={snapAlign ? { scrollSnapAlign: "start" } : undefined}
    >
      {positioned.map((p) => (
        <EventCard
          key={p.event._id}
          positioned={p}
          onClick={() => open({ kind: "event", event: p.event })}
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
