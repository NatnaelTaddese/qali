import { api } from "@qali/backend/convex/_generated/api";
import { cn } from "@qali/ui/lib/utils";
import { useAction } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { EventCard } from "./event-card";
import { EventPopover } from "./event-popover";
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
  status: "armed" | "dragging" | "pending";
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
  const createEvent = useAction(api.calendar.createEvent);
  const ref = useRef<HTMLDivElement>(null);
  const pressClientY = useRef(0);
  const [draft, setDraft] = useState<Draft | null>(null);

  const positioned = useMemo(
    () => layoutDayEvents(events, dayStartMs),
    [events, dayStartMs],
  );

  useEffect(() => {
    if (!draft || draft.status === "pending") return;
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
    if (draft?.status === "pending") return;
    if ((e.target as HTMLElement).closest("[data-event]")) return;
    const anchorMs = Math.min(snappedMs(e.clientY), dayEndMs - SNAP_MS);
    pressClientY.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft({ anchorMs, startMs: anchorMs, endMs: anchorMs + SNAP_MS, status: "armed" });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draft || draft.status === "pending") return;
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
    if (!draft || draft.status === "pending") return;
    // A plain click (never crossed the drag threshold) creates nothing.
    if (draft.status === "armed") {
      setDraft(null);
      return;
    }
    const { startMs, endMs } = draft;
    setDraft({ anchorMs: draft.anchorMs, startMs, endMs, status: "pending" });
    createEvent({ summary: "New event", startMs, endMs })
      .then(() => setDraft(null))
      .catch((error: unknown) => {
        setDraft(null);
        toast.error("Couldn't create event", {
          description: error instanceof Error ? error.message : undefined,
        });
      });
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
        <EventPopover key={p.event._id} event={p.event}>
          <EventCard positioned={p} />
        </EventPopover>
      ))}
      {draft && draft.status !== "armed" && (
        <GhostEvent
          startMs={draft.startMs}
          endMs={draft.endMs}
          dayStartMs={dayStartMs}
          pending={draft.status === "pending"}
        />
      )}
    </div>
  );
}
