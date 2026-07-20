import type { Doc } from "@qali/backend/convex/_generated/dataModel";
import {
  addDays,
  addMonths,
  addWeeks,
  format,
  isSameMonth,
  isSameYear,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";

export type CalendarEvent = Doc<"events">;

export const SNAP_MINUTES = 15;
export const WEEK_STARTS_ON = 1; // Monday

/** The three period granularities the calendar can page through. */
export type CalendarView = "day" | "week" | "month";

/** Pages of buffer rendered on each side of the anchor, per view. Larger =
 * more navigation without a refetch, at the cost of DOM/query size. */
export const VIEW_BUFFER: Record<CalendarView, number> = {
  day: 7,
  week: 3,
  month: 1,
};

/** Time-grid views render a continuous strip of day columns. `columns` is how
 * many are visible at once; `snapDays` is how far a horizontal scroll steps. */
export type StripView = Exclude<CalendarView, "month">;
export const VIEW_COLUMNS: Record<StripView, number> = { day: 1, week: 7 };
export const VIEW_SNAP_DAYS: Record<StripView, number> = { day: 1, week: 3 };
/** Extra day columns rendered off-screen on each side of the visible window. */
export const STRIP_SIDE_DAYS: Record<StripView, number> = { day: 6, week: 12 };

/** The full day columns of a strip: `side` off-screen days, the visible
 * window, then `side` more. The anchor (leftmost visible day) sits at `side`. */
export function stripDays(anchor: Date, columns: number, side: number): Date[] {
  const total = side + columns + side;
  return Array.from({ length: total }, (_, i) => addDays(anchor, i - side));
}

/** Normalize a date to the start of its page for the given view. */
export function pageStart(view: CalendarView, date: Date): Date {
  switch (view) {
    case "day":
      return startOfDay(date);
    case "week":
      return startOfWeek(date, { weekStartsOn: WEEK_STARTS_ON });
    case "month":
      return startOfMonth(date);
  }
}

/** Shift a page start by `n` pages (days / weeks / months). */
export function addPages(view: CalendarView, start: Date, n: number): Date {
  switch (view) {
    case "day":
      return addDays(start, n);
    case "week":
      return addWeeks(start, n);
    case "month":
      return addMonths(start, n);
  }
}

/** The days rendered by a single page. Month pages span a fixed 6×7 grid. */
export function pageDays(view: CalendarView, start: Date): Date[] {
  if (view === "day") return [start];
  if (view === "week") return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const gridStart = startOfWeek(start, { weekStartsOn: WEEK_STARTS_ON });
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

/** Human title for the currently anchored page. */
export function viewTitle(view: CalendarView, start: Date): string {
  if (view === "day") return format(start, "EEEE, MMM d, yyyy");
  if (view === "month") return format(start, "MMMM yyyy");
  const last = addDays(start, 6);
  if (isSameMonth(start, last)) return format(start, "MMMM yyyy");
  const firstFmt = isSameYear(start, last) ? "MMM" : "MMM yyyy";
  return `${format(start, firstFmt)} – ${format(last, "MMM yyyy")}`;
}

/** Smallest per-hour height before the grid stops compressing and scrolls instead. */
export const MIN_HOUR_HEIGHT = 40;
export const MIN_DAY_HEIGHT = 24 * MIN_HOUR_HEIGHT;

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
export const SNAP_MS = SNAP_MINUTES * MS_PER_MINUTE;

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Timezones shown as time gutters, left to right. First is the primary day
 * scale. For now only the user's current timezone is shown; additional zones
 * will be appended here when multi-timezone support lands. */
export const TIMEZONES: { id: string; label: string }[] = [
  { id: LOCAL_TZ, label: LOCAL_TZ.split("/").pop()?.replace(/_/g, " ") ?? "Local" },
];

/** Width of each timezone gutter column, in pixels. */
export const GUTTER_WIDTH = 56;
/** Total width of all gutter columns — where the day columns begin. */
export const GUTTER_TOTAL = GUTTER_WIDTH * TIMEZONES.length;

/** Grid template for `n` equal day columns (the gutter is a pinned sibling). */
export function dayColsTemplate(n: number): string {
  return `repeat(${n}, minmax(0, 1fr))`;
}

/** Fixed height of the weekday/date header row, so the pinned gutter and every
 * page panel line their hour bodies up regardless of which week is visible. */
export const HEADER_DATE_HEIGHT = 44;
/** Reserved height of the all-day band when any all-day event is in view. */
export const ALLDAY_ROW_HEIGHT = 30;

/** Split a page's events into its all-day band and per-day timed columns.
 * Events from the wider buffered window are filtered down to `days` here. */
export function bucketDayEvents(
  days: Date[],
  events: CalendarEvent[],
): { allDayEvents: CalendarEvent[]; timedByDay: CalendarEvent[][] } {
  const rangeStartMs = days[0].getTime();
  const rangeEndMs = days[days.length - 1].getTime() + MS_PER_DAY;
  const allDayEvents: CalendarEvent[] = [];
  const timedByDay: CalendarEvent[][] = days.map(() => []);
  for (const event of events) {
    if (event.allDay) {
      if (event.endMs > rangeStartMs && event.startMs < rangeEndMs) {
        allDayEvents.push(event);
      }
      continue;
    }
    days.forEach((day, i) => {
      const dayStartMs = day.getTime();
      if (event.startMs < dayStartMs + MS_PER_DAY && event.endMs > dayStartMs) {
        timedByDay[i].push(event);
      }
    });
  }
  allDayEvents.sort((a, b) => a.startMs - b.startMs);
  return { allDayEvents, timedByDay };
}

/** Vertical position of an instant as a percentage (0–100) of the day height. */
export function msToPct(ms: number, dayStartMs: number): number {
  return ((ms - dayStartMs) / MS_PER_DAY) * 100;
}

/** Snap a pointer offset within a measured day column to the nearest 15-minute mark. */
export function snappedMsFromOffsetY(
  offsetY: number,
  dayStartMs: number,
  dayHeightPx: number,
): number {
  const steps = Math.round((offsetY / dayHeightPx) * ((24 * 60) / SNAP_MINUTES));
  const ms = dayStartMs + steps * SNAP_MS;
  return Math.min(Math.max(ms, dayStartMs), dayStartMs + MS_PER_DAY);
}

export interface PositionedEvent {
  event: CalendarEvent;
  /** 0–100, distance from the top of the day. */
  topPct: number;
  /** 0–100, share of the day height. */
  heightPct: number;
  /** 0–100, left edge within the day column. */
  leftPct: number;
  /** 0–100, column width share. */
  widthPct: number;
}

/**
 * Position a day's timed events: clamp to the day, then pack transitively
 * overlapping events into side-by-side columns.
 */
export function layoutDayEvents(
  events: CalendarEvent[],
  dayStartMs: number,
): PositionedEvent[] {
  const dayEndMs = dayStartMs + MS_PER_DAY;
  const items = events
    .map((event) => {
      const start = Math.max(event.startMs, dayStartMs);
      const end = Math.min(Math.max(event.endMs, start + SNAP_MS), dayEndMs);
      return { event, start, end, col: 0, cols: 1 };
    })
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

  // Clusters of transitively overlapping events share a column count.
  let cluster: typeof items = [];
  let clusterEnd = -Infinity;
  let colEnds: number[] = [];

  const closeCluster = () => {
    for (const item of cluster) item.cols = colEnds.length;
    cluster = [];
    colEnds = [];
  };

  for (const item of items) {
    if (item.start >= clusterEnd) closeCluster();
    const free = colEnds.findIndex((end) => end <= item.start);
    item.col = free === -1 ? colEnds.length : free;
    colEnds[item.col] = item.end;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  closeCluster();

  return items.map(({ event, start, end, col, cols }) => ({
    event,
    topPct: msToPct(start, dayStartMs),
    heightPct: msToPct(end, dayStartMs) - msToPct(start, dayStartMs),
    leftPct: (col / cols) * 100,
    widthPct: 100 / cols,
  }));
}

// Event/calendar colors live in ./colors.ts — they resolve against Google's
// synced color data rather than anything derived here.
