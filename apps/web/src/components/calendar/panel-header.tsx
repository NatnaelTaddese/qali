import { cn } from "@qali/ui/lib/utils";
import { format, isToday } from "date-fns";
import { motion } from "motion/react";

import { useDock } from "@/components/workspace/dock-context";

import { useEventColor } from "./colors";
import {
  ALLDAY_COLLAPSED_LANES,
  ALLDAY_EVENT_HEIGHT,
  type AllDayEventLayout,
  dayColsTemplate,
  HEADER_DATE_HEIGHT,
} from "./lib";
import { press } from "./motion";

interface PanelHeaderProps {
  days: Date[];
  allDayEvents: AllDayEventLayout[];
  allDayHeight: number;
  allDayExpanded: boolean;
}

/** Weekday/date row plus the all-day band for a single day or week page.
 * Contains no gutter column — the time gutter is pinned as a sibling. */
export function PanelHeader({
  days,
  allDayEvents,
  allDayHeight,
  allDayExpanded,
}: PanelHeaderProps) {
  const { open } = useDock();
  const colorFor = useEventColor();
  const template = dayColsTemplate(days.length);
  return (
    <div
      className="relative flex flex-col border-b border-border bg-background transition-[height] duration-200 motion-reduce:transition-none"
      style={{ height: HEADER_DATE_HEIGHT + allDayHeight }}
    >
      {/* Column dividers as one continuous overlay so the lines run the full
       * header height — through both the date row and the all-day band —
       * rather than stopping where each row's own borders end. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 grid"
        style={{ gridTemplateColumns: template }}
      >
        {days.map((day) => (
          <div key={day.getTime()} className="border-l border-border" />
        ))}
      </div>
      <div
        className="relative grid flex-1"
        style={{ gridTemplateColumns: template }}
      >
        {days.map((day) => {
          const today = isToday(day);
          return (
            <div
              key={day.getTime()}
              className="flex items-baseline gap-1.5 px-2 py-2"
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
      <div
        id="calendar-all-day-rail"
        className={cn(
          "relative grid items-start gap-y-1 py-1 transition-[height] duration-200 motion-reduce:transition-none",
          allDayExpanded ? "overflow-y-auto" : "overflow-hidden",
        )}
        style={{
          gridTemplateColumns: template,
          gridAutoRows: ALLDAY_EVENT_HEIGHT,
          height: allDayHeight,
        }}
      >
        {allDayEvents.map(({ event, startIdx, endIdx, lane }) => {
          if (!allDayExpanded && lane >= ALLDAY_COLLAPSED_LANES) return null;
          const colorVar = colorFor(event);
          return (
            <motion.button
              type="button"
              key={event._id}
              data-event
              onClick={() => open({ kind: "event", event })}
              whileTap={press.whileTap}
              transition={{ scale: press.transition }}
              className="relative mx-1 flex items-center overflow-hidden rounded-md py-0.5 pr-2 pl-2.5 text-left text-xs font-medium ring-1 ring-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                gridColumn: `${startIdx + 1} / ${endIdx + 2}`,
                gridRow: lane + 1,
                backgroundColor: `color-mix(in oklab, var(${colorVar}) 22%, var(--card))`,
              }}
            >
              <span
                aria-hidden
                className="absolute top-1 bottom-1 left-1 w-[3px] rounded-full"
                style={{ backgroundColor: `var(${colorVar})` }}
              />
              <span className="truncate">{event.summary ?? "(No title)"}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
