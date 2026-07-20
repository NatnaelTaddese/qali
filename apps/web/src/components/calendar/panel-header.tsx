import { cn } from "@qali/ui/lib/utils";
import { differenceInCalendarDays, format, isToday } from "date-fns";
import { motion } from "motion/react";

import { useDock } from "@/components/workspace/dock-context";

import { useEventColor } from "./colors";
import { dayColsTemplate, HEADER_DATE_HEIGHT, type CalendarEvent } from "./lib";
import { press } from "./motion";

interface PanelHeaderProps {
  days: Date[];
  allDayEvents: CalendarEvent[];
  /** Reserved all-day band height — uniform across the pager so hour bodies
   * stay aligned with the pinned gutter. 0 when nothing is all-day in view. */
  allDayHeight: number;
}

/** Weekday/date row plus the all-day band for a single day or week page.
 * Contains no gutter column — the time gutter is pinned as a sibling. */
export function PanelHeader({ days, allDayEvents, allDayHeight }: PanelHeaderProps) {
  const { open } = useDock();
  const colorFor = useEventColor();
  const template = dayColsTemplate(days.length);
  return (
    <div
      className="flex flex-col border-b border-border bg-background"
      style={{ height: HEADER_DATE_HEIGHT + allDayHeight }}
    >
      <div
        className="grid flex-1"
        style={{ gridTemplateColumns: template }}
      >
        {days.map((day) => {
          const today = isToday(day);
          return (
            <div
              key={day.getTime()}
              className="flex items-baseline gap-1.5 border-l border-border px-2 py-2"
            >
              <span
                className={cn(
                  "text-[11px] font-medium tracking-wide uppercase",
                  today ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {format(day, "EEE")}
              </span>
              <span
                className={cn(
                  "text-base font-semibold",
                  today &&
                    "flex size-7 items-center justify-center self-center rounded-full bg-primary text-primary-foreground",
                )}
              >
                {format(day, "d")}
              </span>
            </div>
          );
        })}
      </div>
      {allDayHeight > 0 && (
        <div
          className="grid items-start gap-y-1 overflow-y-auto py-1"
          style={{ gridTemplateColumns: template, height: allDayHeight }}
        >
          {allDayEvents.map((event) => {
            // Google all-day endMs is exclusive midnight.
            const startIdx = Math.max(
              differenceInCalendarDays(event.startMs, days[0]),
              0,
            );
            const endIdx = Math.min(
              differenceInCalendarDays(event.endMs - 1, days[0]),
              days.length - 1,
            );
            const colorVar = colorFor(event);
            return (
              <motion.div
                  key={event._id}
                  data-event
                  onClick={() => open({ kind: "event", event })}
                  whileTap={press.whileTap}
                  transition={{ scale: press.transition }}
                  className="mx-0.5 cursor-pointer truncate rounded-md border-l-[3px] px-2 py-0.5 text-xs font-medium ring-1 ring-border/60"
                  style={{
                    gridColumn: `${startIdx + 1} / ${endIdx + 2}`,
                    backgroundColor: `color-mix(in oklab, var(${colorVar}) 22%, var(--card))`,
                    borderLeftColor: `var(${colorVar})`,
                  }}
                >
                  {event.summary ?? "(No title)"}
                </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
