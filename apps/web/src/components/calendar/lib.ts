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

/** User-facing Google calendar name, including a per-user override when one
 * exists. */
export function calendarDisplayName(calendar: {
  googleCalendarId: string;
  summary?: string;
  summaryOverride?: string;
}): string {
  return (
    calendar.summaryOverride ?? calendar.summary ?? calendar.googleCalendarId
  );
}

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
 * many are visible at once; navigation buttons move by `VIEW_NAV_DAYS`. */
export type StripView = Exclude<CalendarView, "month">;
export const VIEW_COLUMNS: Record<StripView, number> = { day: 1, week: 7 };
export const VIEW_NAV_DAYS: Record<StripView, number> = { day: 1, week: 3 };
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
/** Geometry for the all-day rail. The compact rail shows at most two lanes. */
export const ALLDAY_COLLAPSED_LANES = 2;
export const ALLDAY_MAX_EXPANDED_LANES = 8;
export const ALLDAY_EVENT_HEIGHT = 20;
export const ALLDAY_EVENT_GAP = 4;
export const ALLDAY_BAND_PADDING = 4;

export function allDayBandHeight(laneCount: number, expanded: boolean): number {
  const visibleLanes = expanded
    ? Math.min(Math.max(laneCount, 1), ALLDAY_MAX_EXPANDED_LANES)
    : Math.max(Math.min(laneCount, ALLDAY_COLLAPSED_LANES), 1);
  return (
    ALLDAY_BAND_PADDING * 2 +
    visibleLanes * ALLDAY_EVENT_HEIGHT +
    (visibleLanes - 1) * ALLDAY_EVENT_GAP
  );
}

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

/** Inclusive `[startIdx, endIdx]` day columns an all-day event covers within
 * `days`, clamped to the visible range. All-day boundaries are stored as
 * UTC-midnight instants (Google date-only), so indices are derived in UTC —
 * comparing them with a local calendar-day diff shifts events by the UTC
 * offset and can spill a single-day event into the next column. */
export function allDayColumnSpan(
  event: CalendarEvent,
  days: Date[],
): { startIdx: number; endIdx: number } {
  const first = days[0];
  const base = Date.UTC(first.getFullYear(), first.getMonth(), first.getDate());
  const lastIdx = days.length - 1;
  const startIdx = Math.round((event.startMs - base) / MS_PER_DAY);
  // endMs is the exclusive UTC midnight after the last day; step back to the
  // last day the event actually occupies.
  const endIdx = Math.round((event.endMs - MS_PER_DAY - base) / MS_PER_DAY);
  return {
    startIdx: Math.max(startIdx, 0),
    endIdx: Math.min(Math.max(endIdx, startIdx), lastIdx),
  };
}

export interface AllDayEventLayout {
  event: CalendarEvent;
  startIdx: number;
  endIdx: number;
  lane: number;
}

/** Pack spanning all-day events into the first available non-overlapping lane. */
export function layoutAllDayEvents(
  days: Date[],
  events: CalendarEvent[],
  visibleStartIdx = 0,
  visibleEndIdx = days.length - 1,
): AllDayEventLayout[] {
  const spans = events
    .map((event) => ({ event, ...allDayColumnSpan(event, days) }))
    .filter(
      ({ startIdx, endIdx }) =>
        endIdx >= visibleStartIdx && startIdx <= visibleEndIdx,
    )
    .map((span) => ({
      ...span,
      startIdx: Math.max(span.startIdx, visibleStartIdx),
      endIdx: Math.min(span.endIdx, visibleEndIdx),
    }))
    .sort(
      (a, b) =>
        a.startIdx - b.startIdx ||
        b.endIdx - a.endIdx ||
        a.event.startMs - b.event.startMs ||
        String(a.event._id).localeCompare(String(b.event._id)),
    );
  const laneEnds: number[] = [];

  return spans.map((span) => {
    let lane = laneEnds.findIndex((endIdx) => endIdx < span.startIdx);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = span.endIdx;
    return { ...span, lane };
  });
}

export function visibleAllDayMetrics(
  events: AllDayEventLayout[],
  visibleStartIdx: number,
  visibleEndIdx: number,
): { laneCount: number; hiddenEventCount: number } {
  let laneCount = 0;
  let hiddenEventCount = 0;

  for (const event of events) {
    if (event.endIdx < visibleStartIdx || event.startIdx > visibleEndIdx) continue;
    laneCount = Math.max(laneCount, event.lane + 1);
    if (event.lane >= ALLDAY_COLLAPSED_LANES) hiddenEventCount += 1;
  }

  return { laneCount, hiddenEventCount };
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
  /** Cascade depth: how many earlier events in the cluster are still running at
   * this event's start. 0 is the leftmost card; deeper cards indent further
   * right. Drives the horizontal indent only — not the paint order. */
  stackIndex: number;
  /** Number of cards in this event's overlap cluster (1 when it stands alone). */
  stackCount: number;
  /** Paint order within the cluster (0 = earliest start). Higher sits on top, so
   * a later-starting event is never buried under an earlier, longer one. */
  elevation: number;
}

/** Horizontal shift, in pixels, applied per stack level in the overlap cascade. */
export const STACK_INDENT_PX = 14;
/** Stack levels that get the full indent before it stops growing. */
const STACK_MAX_LEVELS = 3;
/** Thin residual indent per level past the cap, so deep cards still peek out. */
const STACK_DEEP_STEP_PX = 4;

/** Left indent (px) for a card at `stackIndex`, capped so the front cards stay
 * wide in deep overlaps while every card behind still exposes a clickable left
 * sliver (the residual keeps the indent monotonic past the cap). */
export function stackIndentPx(stackIndex: number): number {
  const capped = Math.min(stackIndex, STACK_MAX_LEVELS);
  const overflow = Math.max(0, stackIndex - STACK_MAX_LEVELS);
  return capped * STACK_INDENT_PX + overflow * STACK_DEEP_STEP_PX;
}

/**
 * Position a day's timed events: clamp to the day, then cascade transitively
 * overlapping events. Each event indents past the earlier events still running
 * at its start (`stackIndex`) and paints in start order (`elevation`), so a
 * later, shorter event always sits on top of the earlier ones it overlaps
 * instead of being buried under them.
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
      return { event, start, end, stackIndex: 0, stackCount: 1, elevation: 0 };
    })
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

  // Walk events in start order, grouping transitively overlapping ones into
  // clusters. `cluster` holds the earlier members still relevant to the run.
  let cluster: typeof items = [];
  let clusterEnd = -Infinity;

  const closeCluster = () => {
    for (const item of cluster) item.stackCount = cluster.length;
    cluster = [];
  };

  for (const item of items) {
    if (item.start >= clusterEnd) closeCluster();
    // Indent past every earlier cluster member still running at our start.
    item.stackIndex = cluster.filter((prev) => prev.end > item.start).length;
    // Paint order: later starts sit on top of earlier ones in the cluster.
    item.elevation = cluster.length;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  closeCluster();

  return items.map(({ event, start, end, stackIndex, stackCount, elevation }) => ({
    event,
    topPct: msToPct(start, dayStartMs),
    heightPct: msToPct(end, dayStartMs) - msToPct(start, dayStartMs),
    stackIndex,
    stackCount,
    elevation,
  }));
}

// Event/calendar colors live in ./colors.ts — they resolve against Google's
// synced color data rather than anything derived here.
