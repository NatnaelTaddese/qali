import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { startOfDay } from "date-fns";

import {
  GUTTER_WIDTH,
  HEADER_DATE_HEIGHT,
  MIN_DAY_HEIGHT,
  msToPct,
  TIMEZONES,
} from "./lib";
import { TimeGutter } from "./time-gutter";

const nowFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: TIMEZONES[0].id,
});

function formatNow(now: number): string {
  return nowFmt
    .formatToParts(now)
    .filter(({ type }) => type !== "dayPeriod")
    .map(({ value }) => value)
    .join("")
    .trim();
}

/** The hour-labels column, pinned to the left of the paging day/week panels.
 * Its header block matches the panel header height so the hour rows align. */
export function GutterColumn({
  allDayHeight,
  allDayExpanded,
  hiddenAllDayEventCount,
  onToggleAllDay,
  now,
}: {
  allDayHeight: number;
  allDayExpanded: boolean;
  hiddenAllDayEventCount: number;
  onToggleAllDay: () => void;
  now: number;
}) {
  const dayStartMs = startOfDay(new Date()).getTime();
  const nowTopPct = msToPct(now, startOfDay(now).getTime());
  return (
    <div className="flex h-full flex-col bg-background">
      <div
        className="sticky top-0 z-10 flex shrink-0 items-start gap-1 border-b border-border bg-calendar-header px-1.5 py-2 backdrop-blur-xs transition-[height] duration-200 motion-reduce:transition-none"
        style={{ height: HEADER_DATE_HEIGHT + allDayHeight }}
      >
        <button
          type="button"
          aria-label="Add timezone"
          className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-3" />
        </button>
        {TIMEZONES.map((tz) => (
          <span
            key={tz.id}
            className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
          >
            {tz.label}
          </span>
        ))}
        {hiddenAllDayEventCount > 0 && (
          <button
            type="button"
            aria-controls="calendar-all-day-rail"
            aria-expanded={allDayExpanded}
            aria-label={
              allDayExpanded
                ? "Collapse all-day events"
                : `Show ${hiddenAllDayEventCount} more all-day ${hiddenAllDayEventCount === 1 ? "event" : "events"}`
            }
            onClick={onToggleAllDay}
            className="absolute right-1 bottom-1 flex h-5 items-center gap-0.5 rounded-md bg-accent px-1 text-[10px] font-medium text-muted-foreground ring-1 ring-border/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {!allDayExpanded && <span>+{hiddenAllDayEventCount}</span>}
            <HugeiconsIcon
              icon={allDayExpanded ? ArrowUp01Icon : ArrowDown01Icon}
              strokeWidth={2}
              className="size-3"
            />
          </button>
        )}
      </div>
      <div className="relative flex flex-1" style={{ minHeight: MIN_DAY_HEIGHT }}>
        {TIMEZONES.map((tz) => (
          <div key={tz.id} className="h-full" style={{ width: GUTTER_WIDTH }}>
            <TimeGutter timeZone={tz.id} dayStartMs={dayStartMs} />
          </div>
        ))}
        <span
          className="pointer-events-none absolute right-1.5 z-0 -translate-y-1/2 rounded-full bg-red-500 px-1.5 py-0.5 text-xs font-semibold leading-none tabular-nums text-white shadow-sm"
          style={{ top: `${nowTopPct}%` }}
        >
          {formatNow(now)}
          <span
            aria-hidden
            className="absolute top-1/2 left-full h-0.5 w-1.5 -translate-y-1/2 bg-red-500"
          />
        </span>
      </div>
    </div>
  );
}
