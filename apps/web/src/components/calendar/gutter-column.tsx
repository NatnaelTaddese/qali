import {
  ArrowDown01Icon,
  ArrowUp01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { format, startOfDay } from "date-fns";

import { usePreferences } from "@/components/workspace/preferences-context";
import {
  GUTTER_WIDTH,
  HEADER_DATE_HEIGHT,
  MIN_DAY_HEIGHT,
  msToPct,
  TIME_GRID_BOTTOM_SPACER_HEIGHT,
  timePattern,
  timezoneGutters,
  zoned,
} from "./lib";
import { TimeGutter } from "./time-gutter";

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
  const { use24h, timeZone } = usePreferences();
  const gutters = timezoneGutters(timeZone);
  const nowDate = zoned(now, timeZone);
  const dayStartMs = startOfDay(nowDate).getTime();
  const nowTopPct = msToPct(now, dayStartMs);
  return (
    <div className="flex h-full flex-col bg-background">
      <div
        className="sticky top-0 z-10 flex shrink-0 items-start gap-1 border-b border-border bg-calendar-header px-1.5 py-2 backdrop-blur-xs transition-[height] duration-200 motion-reduce:transition-none"
        style={{ height: HEADER_DATE_HEIGHT + allDayHeight }}
      >
        {gutters.map((tz) => (
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
      {/* The sticky gutter wrapper is stretched only to the scroller's client
          height, but the day strip's content runs taller (MIN_DAY_HEIGHT grid +
          spacer). These children carry their own bg so the gutter stays opaque
          through that overflow — otherwise the off-screen buffer day bleeds
          through at the bottom. */}
      <div
        className="relative flex flex-1 bg-background"
        style={{ minHeight: MIN_DAY_HEIGHT }}
      >
        {gutters.map((tz) => (
          // Flex stretch (not h-full): the gutter wrapper is content-height
          // now, so a percentage chain has nothing definite to resolve against.
          <div key={tz.id} style={{ width: GUTTER_WIDTH }}>
            <TimeGutter timeZone={tz.id} dayStartMs={dayStartMs} />
          </div>
        ))}
        <span
          className="pointer-events-none absolute right-1.5 z-0 -translate-y-1/2 rounded-full bg-red-500 px-1.5 py-0.5 text-xs font-semibold leading-none tabular-nums text-white shadow-sm"
          style={{ top: `${nowTopPct}%` }}
        >
          {format(nowDate, timePattern(use24h, false))}
          <span
            aria-hidden
            className="absolute top-1/2 left-full h-0.5 w-1.5 -translate-y-1/2 bg-red-500"
          />
        </span>
      </div>
      <div
        aria-hidden
        className="shrink-0 bg-background"
        style={{ height: TIME_GRID_BOTTOM_SPACER_HEIGHT }}
      />
    </div>
  );
}
