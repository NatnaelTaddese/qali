import { cn } from "@qali/ui/lib/utils";
import { addDays, format, isSameMonth, isToday, startOfWeek } from "date-fns";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useDock } from "@/components/workspace/dock-context";

import { useEventColor } from "./colors";
import {
  MONTH_EVENT_ROW_HEIGHT,
  MS_PER_DAY,
  visibleMonthEventMetrics,
  WEEK_STARTS_ON,
  type CalendarEvent,
} from "./lib";

const WEEK_REF = startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON });
const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, i) =>
  format(addDays(WEEK_REF, i), "EEE"),
);

interface MonthPanelProps {
  /** The month's anchor (its first day). */
  monthStart: Date;
  /** The 42 days of the 6×7 grid. */
  days: Date[];
  /** Events for the whole buffered window; filtered per day internally. */
  events: CalendarEvent[];
  /** Open a specific day in day view. */
  onSelectDay: (day: Date) => void;
}

/** A single month page: weekday labels over a 6×7 grid of day cells. */
export function MonthPanel({ monthStart, days, events, onSelectDay }: MonthPanelProps) {
  const { open } = useDock();
  const colorFor = useEventColor();
  const eventAreaRef = useRef<HTMLDivElement>(null);
  const [eventAreaHeight, setEventAreaHeight] = useState(0);
  const eventsByDay = useMemo(() => {
    return days.map((day) => {
      const dayStartMs = day.getTime();
      const dayEndMs = dayStartMs + MS_PER_DAY;
      return events
        .filter((e) => e.startMs < dayEndMs && e.endMs > dayStartMs && e.status !== "cancelled")
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs);
    });
  }, [days, events]);

  useLayoutEffect(() => {
    const eventArea = eventAreaRef.current;
    if (!eventArea) return;

    const updateHeight = () => {
      const height = eventArea.getBoundingClientRect().height;
      setEventAreaHeight((current) => (current === height ? current : height));
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(eventArea);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 z-30 grid grid-cols-7 border-b border-border bg-calendar-header backdrop-blur-xs">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="px-2 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((day, i) => {
          const inMonth = isSameMonth(day, monthStart);
          const today = isToday(day);
          const dayEvents = eventsByDay[i];
          const { visibleCount, hiddenCount } = visibleMonthEventMetrics(
            dayEvents.length,
            eventAreaHeight,
          );
          return (
            <button
              type="button"
              key={day.getTime()}
              onClick={() => onSelectDay(day)}
              className={cn(
                "flex min-h-0 flex-col gap-0.5 border-b border-l border-border p-1 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                !inMonth && "bg-muted/30 text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center self-start text-xs font-medium",
                  today && "rounded-full bg-primary text-primary-foreground",
                )}
              >
                {format(day, "d")}
              </span>
              <div
                ref={i === 0 ? eventAreaRef : undefined}
                className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden"
              >
                {dayEvents.slice(0, visibleCount).map((event) => {
                  const colorVar = colorFor(event);
                  return (
                    <span
                      key={event._id}
                      data-event
                      onClick={(e) => {
                        // Don't let the day cell's onSelectDay fire too.
                        e.stopPropagation();
                        open({ kind: "event", event });
                      }}
                      className="flex shrink-0 items-center gap-1 truncate rounded px-1 text-[11px] leading-tight"
                      style={{
                        height: MONTH_EVENT_ROW_HEIGHT,
                        backgroundColor: `color-mix(in oklab, var(${colorVar}) 18%, var(--card))`,
                      }}
                    >
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: `var(${colorVar})` }}
                      />
                      <span className="truncate">{event.summary ?? "(No title)"}</span>
                    </span>
                  );
                })}
                {hiddenCount > 0 && (
                  <span
                    className="flex shrink-0 items-center px-1 text-[10px] text-muted-foreground"
                    style={{ height: MONTH_EVENT_ROW_HEIGHT }}
                  >
                    +{hiddenCount} more
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
