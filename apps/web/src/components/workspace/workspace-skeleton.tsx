import { Skeleton } from "@qali/ui/components/skeleton";

import {
  dayColsTemplate,
  GUTTER_WIDTH,
  HEADER_DATE_HEIGHT,
  MIN_HOUR_HEIGHT,
} from "@/components/calendar/lib";

/** Faint placeholder events, positioned as [dayIndex, topHour, spanHours] so
 * the grid reads as a populated week rather than an empty scaffold. */
const GHOST_EVENTS: [day: number, top: number, span: number][] = [
  [0, 9, 1],
  [1, 10.5, 2],
  [1, 14, 1],
  [2, 8, 1.5],
  [3, 11, 1],
  [3, 15.5, 2],
  [4, 9.5, 1],
  [4, 13, 1.5],
  [5, 12, 1],
  [6, 10, 2],
];

const HOUR_LABELS = Array.from({ length: 13 }, (_, i) => i);

/**
 * Static loading placeholder for the workspace, shown while Convex auth
 * resolves. Mirrors the calendar shell — header bar, pinned time gutter, week
 * grid, and the bottom island — so the boot reads as intentional rather than a
 * blank screen, and swaps out without a layout jump once the real calendar
 * mounts.
 */
export function WorkspaceSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading workspace"
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <span className="sr-only">Loading</span>

      {/* Header bar — mirrors calendar.tsx <header>. */}
      <div
        aria-hidden
        className="flex items-center justify-between gap-4 border-t border-border/80 bg-calendar-header px-4 py-2.5"
      >
        <Skeleton className="h-5 w-40 rounded-md" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-44 rounded-lg" />
          <div className="flex items-center gap-1">
            <Skeleton className="h-7 w-14 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
          </div>
          <div className="flex items-center -space-x-1.5">
            <Skeleton className="size-4 rounded-full ring-2 ring-background" />
            <Skeleton className="size-4 rounded-full ring-2 ring-background" />
            <Skeleton className="size-4 rounded-full ring-2 ring-background" />
          </div>
        </div>
      </div>

      {/* Body — pinned gutter + 7-day grid. */}
      <div
        aria-hidden
        className="flex min-h-0 flex-1 overflow-hidden bg-calendar-header"
      >
        {/* Time gutter. */}
        <div
          className="flex shrink-0 flex-col bg-background"
          style={{ width: GUTTER_WIDTH }}
        >
          <div
            className="shrink-0 border-b border-border"
            style={{ height: HEADER_DATE_HEIGHT }}
          />
          <div className="flex flex-col">
            {HOUR_LABELS.map((h) => (
              <div
                key={h}
                className="flex justify-end px-1.5 pt-1"
                style={{ height: MIN_HOUR_HEIGHT }}
              >
                <Skeleton className="h-2.5 w-8 rounded" />
              </div>
            ))}
          </div>
        </div>

        {/* Day area. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Weekday/date header strip. */}
          <div
            className="grid shrink-0 border-b border-border"
            style={{
              gridTemplateColumns: dayColsTemplate(7),
              height: HEADER_DATE_HEIGHT,
            }}
          >
            {Array.from({ length: 7 }, (_, i) => (
              <div
                key={i}
                className="flex flex-col items-center justify-center gap-1 border-l border-border"
              >
                <Skeleton className="h-2 w-6 rounded" />
                <Skeleton className="h-3.5 w-5 rounded" />
              </div>
            ))}
          </div>

          {/* Hour grid with faint placeholder events. */}
          <div
            className="grid min-h-0 flex-1"
            style={{
              gridTemplateColumns: dayColsTemplate(7),
              backgroundImage:
                "linear-gradient(to bottom, color-mix(in oklab, var(--border) 55%, transparent) 0 1px, transparent 1px)",
              backgroundSize: `100% ${MIN_HOUR_HEIGHT}px`,
            }}
          >
            {Array.from({ length: 7 }, (_, day) => (
              <div key={day} className="relative border-l border-border">
                {GHOST_EVENTS.filter(([d]) => d === day).map(
                  ([, top, span], i) => (
                    <Skeleton
                      key={i}
                      className="absolute inset-x-1 rounded-lg opacity-70"
                      style={{
                        top: top * MIN_HOUR_HEIGHT,
                        height: span * MIN_HOUR_HEIGHT - 4,
                      }}
                    />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom island placeholder — mirrors the collapsed nav pill. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
      >
        <div className="flex items-center gap-1 rounded-[28px] border border-border bg-popover/90 px-2 py-1.5 shadow-lg backdrop-blur">
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="size-9 rounded-lg" />
          <div className="mx-1 h-6 w-px bg-border" />
          <Skeleton className="size-8 rounded-full" />
        </div>
      </div>
    </div>
  );
}
