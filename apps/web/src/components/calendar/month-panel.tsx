import { cn } from "@qali/ui/lib/utils";
import { addDays, format, isSameMonth, isToday, startOfWeek } from "date-fns";
import { useMemo } from "react";

import { useDock } from "@/components/workspace/dock-context";

import { eventColorVar, MS_PER_DAY, WEEK_STARTS_ON, type CalendarEvent } from "./lib";

const MAX_CHIPS = 3;
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
  const eventsByDay = useMemo(() => {
    return days.map((day) => {
      const dayStartMs = day.getTime();
      const dayEndMs = dayStartMs + MS_PER_DAY;
      return events
        .filter((e) => e.startMs < dayEndMs && e.endMs > dayStartMs && e.status !== "cancelled")
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs);
    });
  }, [days, events]);

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-30 grid grid-cols-7 border-b border-border bg-background">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="px-2 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 grid-rows-6">
        {days.map((day, i) => {
          const inMonth = isSameMonth(day, monthStart);
          const today = isToday(day);
          const dayEvents = eventsByDay[i];
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
              <div className="flex min-h-0 flex-col gap-0.5 overflow-hidden">
                {dayEvents.slice(0, MAX_CHIPS).map((event) => {
                  const colorVar = eventColorVar(event);
                  return (
                    <span
                        key={event._id}
                        data-event
                        onClick={(e) => {
                          // Don't let the day cell's onSelectDay fire too.
                          e.stopPropagation();
                          open({ kind: "event", event });
                        }}
                        className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px] leading-tight"
                        style={{
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
                {dayEvents.length > MAX_CHIPS && (
                  <span className="px-1 text-[10px] text-muted-foreground">
                    +{dayEvents.length - MAX_CHIPS} more
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
