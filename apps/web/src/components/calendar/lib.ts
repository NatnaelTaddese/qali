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

/** Pages of buffer rendered on each side of the anchor, per view.
 *
 * This is a *rendering* cost, not a data one: how far you can fling before the
 * strip rebuilds. Every extra column is reconciled on each column crossing
 * during a gesture, and a wider strip measurably degrades scrolling — 3 pages
 * (49 columns) was tried and is too heavy. How far you can scroll without
 * *refetching* is set separately, and much more generously, by
 * `QUERY_SIDE_WEEKS`/`QUERY_SIDE_MONTHS`; widen those instead.
 *
 * Month stays at 1: at a measured ~1.3 KB per event its 7-month query window
 * already hits Convex's 8 MiB response limit above ~31 events/day, and a
 * buffer of 2 would widen that to 11 months and drop the ceiling to ~20 —
 * reachable with several team calendars, and it throws rather than degrading.
 * One page either side suffices anyway, since `scrollSnapStop: "always"` caps
 * a month flick at a single page. */
export const VIEW_BUFFER: Record<CalendarView, number> = {
  day: 7,
  week: 2,
  month: 1,
};

/** Time-grid views render a continuous strip of day columns. `columns` is how
 * many are visible at once; navigation buttons move by `VIEW_NAV_DAYS`. */
export type StripView = Exclude<CalendarView, "month">;
export const VIEW_COLUMNS: Record<StripView, number> = { day: 1, week: 7 };
export const VIEW_NAV_DAYS: Record<StripView, number> = { day: 1, week: 3 };
/** Extra day columns rendered off-screen on each side of the visible window —
 * `VIEW_BUFFER` pages' worth, so the two constants can't drift apart. */
export const STRIP_SIDE_DAYS: Record<StripView, number> = {
  day: VIEW_BUFFER.day * VIEW_COLUMNS.day,
  week: VIEW_BUFFER.week * VIEW_COLUMNS.week,
};

/** Interned day starts, so the same calendar day is always the same `Date`
 * object. Stepping the anchor rebuilds the strip but keeps all but one column's
 * `day` prop referentially equal, which is what lets the memoized day columns
 * skip re-rendering on the settle frame. */
const dayCache = new Map<number, Date>();
/** Comfortably more than the widest strip plus a few anchor steps; trimmed
 * wholesale rather than by LRU since a stale entry costs only a re-render. */
const DAY_CACHE_LIMIT = 512;

function internDay(date: Date): Date {
  const key = date.getTime();
  const cached = dayCache.get(key);
  if (cached) return cached;
  if (dayCache.size >= DAY_CACHE_LIMIT) dayCache.clear();
  dayCache.set(key, date);
  return date;
}

/** The full day columns of a strip: `side` off-screen days, the visible
 * window, then `side` more. The anchor (leftmost visible day) sits at `side`. */
export function stripDays(anchor: Date, columns: number, side: number): Date[] {
  const total = side + columns + side;
  return Array.from({ length: total }, (_, i) =>
    internDay(addDays(anchor, i - side)),
  );
}

// A settle can move the anchor by at most the buffer (the scroller cannot
// reach further than the rendered strip), so from any anchor the next anchor
// is within `VIEW_BUFFER` pages. The query window must still cover the strip
// rendered *there*, or the retained previous result has a hole in it and those
// columns render empty until the new query lands. Solving that containment for
// the forward case — anchor up to a page into its quantized period, plus a
// full-buffer settle, plus the far side of the new strip — gives 2·buffer + 1.
/** Weeks of events fetched each side of the anchor's week, for the day/week
 * strips. Derived so `eventQueryRange` provably covers any reachable strip. */
export const QUERY_SIDE_WEEKS = 2 * VIEW_BUFFER.week + 1;
/** Months of events fetched each side of the anchor's month, for month view.
 * Month anchors are always month starts, but a page's 6×7 grid overhangs its
 * month by up to 6 days on each end, so the same margin covers it. */
export const QUERY_SIDE_MONTHS = 2 * VIEW_BUFFER.month + 1;

/**
 * The event-query window for an anchor, quantized to a week (strip views) or
 * month (month view) boundary.
 *
 * Convex keys subscriptions on their args, so a window derived directly from
 * the rendered range mints a brand-new subscription — and a full round-trip —
 * every time the anchor moves a single day, even though consecutive windows
 * overlap almost entirely. Snapping to a coarser boundary means scrolling
 * within it reuses the identical subscription and never refetches.
 *
 * The padding is deliberately generous: the window for a given anchor covers
 * not just that anchor's strip but every strip reachable while the window
 * stays put, so crossing a boundary never leaves a gap the previous result
 * couldn't fill.
 */
export function eventQueryRange(
  view: CalendarView,
  anchor: Date,
): { startMs: number; endMs: number } {
  if (view === "month") {
    const base = startOfMonth(anchor);
    return {
      startMs: addMonths(base, -QUERY_SIDE_MONTHS).getTime(),
      endMs: addMonths(base, QUERY_SIDE_MONTHS + 1).getTime(),
    };
  }
  const base = startOfWeek(anchor, { weekStartsOn: WEEK_STARTS_ON });
  return {
    startMs: addWeeks(base, -QUERY_SIDE_WEEKS).getTime(),
    endMs: addWeeks(base, QUERY_SIDE_WEEKS + 1).getTime(),
  };
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

// Scroll-settle mechanics, shared by the day/week strip and the month pager.

/** Tolerance, in px, for treating a scroll position as "already at target".
 * Column and page widths are fractional, so exact equality never holds. */
export const SNAP_EPSILON = 2;
/** Idle gap that counts as a settle when `scrollend` isn't available. */
export const SETTLE_IDLE_MS = 140;
/** Slower safety net where `scrollend` exists but can be skipped (e.g. a scroll
 * cancelled by snap correction). Firing early is harmless: a settle at the
 * anchor computes delta 0. */
export const SETTLE_BACKSTOP_MS = 400;
/** Whether the browser fires `scrollend`. Safari only shipped it in 26.2, so
 * the inactivity timer above remains the primary path there. */
export const SUPPORTS_SCROLL_END =
  typeof window !== "undefined" && "onscrollend" in window;

/** Smallest per-hour height before the grid stops compressing and scrolls instead. */
export const MIN_HOUR_HEIGHT = 40;
export const MIN_DAY_HEIGHT = 24 * MIN_HOUR_HEIGHT;
/** Scroll room below the 24-hour scale, mirrored by the gutter for alignment. */
export const TIME_GRID_BOTTOM_SPACER_HEIGHT = 96;

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
export const SNAP_MS = SNAP_MINUTES * MS_PER_MINUTE;

/** Format minutes from midnight without interpreting them as an instant. */
export function formatWallClockMinutes(
  minutes: number,
  includeDayPeriod = true,
): string {
  const normalized = ((Math.round(minutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const hour12 = hour24 % 12 || 12;
  const time = `${hour12}:${String(minute).padStart(2, "0")}`;
  if (!includeDayPeriod) return time;
  return `${time} ${hour24 < 12 ? "AM" : "PM"}`;
}

export const MONTH_EVENT_ROW_HEIGHT = 18;
export const MONTH_EVENT_ROW_GAP = 2;

/** Determine how many month-view events fit, reserving the final row for the
 * overflow count when every event cannot be shown. */
export function visibleMonthEventMetrics(
  eventCount: number,
  availableHeight: number,
): { visibleCount: number; hiddenCount: number } {
  const availableRows = Math.max(
    Math.floor(
      (availableHeight + MONTH_EVENT_ROW_GAP) /
        (MONTH_EVENT_ROW_HEIGHT + MONTH_EVENT_ROW_GAP),
    ),
    0,
  );
  const visibleCount =
    eventCount <= availableRows ? eventCount : Math.max(availableRows - 1, 0);

  return { visibleCount, hiddenCount: eventCount - visibleCount };
}

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Timezones shown as time gutters, left to right. First is the primary day
 * scale. For now only the user's current timezone is shown; additional zones
 * will be appended here when multi-timezone support lands. */
export const TIMEZONES: { id: string; label: string }[] = [
  { id: LOCAL_TZ, label: LOCAL_TZ.split("/").pop()?.replace(/_/g, " ") ?? "Local" },
];

/** Width of each timezone gutter column, in pixels. */
export const GUTTER_WIDTH = 64;
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
  // Hoisted out of the per-event loop: this runs on every column crossing
  // during a scroll, over the whole (deliberately wide) query window, so a
  // `getTime()` per event per day is real work to avoid.
  const dayStarts = days.map((day) => day.getTime());
  const rangeStartMs = dayStarts[0];
  const rangeEndMs = dayStarts[dayStarts.length - 1] + MS_PER_DAY;
  const allDayEvents: CalendarEvent[] = [];
  const timedByDay: CalendarEvent[][] = days.map(() => []);
  for (const event of events) {
    if (event.allDay) {
      if (event.endMs > rangeStartMs && event.startMs < rangeEndMs) {
        allDayEvents.push(event);
      }
      continue;
    }
    for (let i = 0; i < dayStarts.length; i++) {
      const dayStartMs = dayStarts[i];
      // Days ascend, so once one starts at or after the event's end, no later
      // day can overlap it either.
      if (dayStartMs >= event.endMs) break;
      if (dayStartMs + MS_PER_DAY <= event.startMs) continue;
      timedByDay[i].push(event);
    }
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
  /** Column (lane) this event occupies in side-by-side layout. 0 is leftmost. */
  columnIndex: number;
  /** Number of columns the event's cluster splits into (1 when it stands alone). */
  columnCount: number;
  /** How many columns the card fills once it expands right into free space
   * (>= 1). `columnIndex + columnSpan <= columnCount`. */
  columnSpan: number;
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

/** How far the next overlapping card advances past the previous one, as a
 * fraction of a card's width. Below 1 so side-by-side cards overlap enough to
 * read as a stack rather than splitting into clean, disconnected halves. */
export const LANE_ADVANCE_RATIO = 0.62;

/** Horizontal box (`left`/`width` as 0–1 fractions of the column) for an event
 * laid out in side-by-side lanes. Cards fan left-to-right and overlap by
 * `1 - LANE_ADVANCE_RATIO` of their width, so each exposes its own left edge
 * while the later card (painted on top) still overlaps it. A card widens across
 * `columnSpan` lanes when it can expand right into free space; a card that
 * reaches the last lane extends to the column's right edge. */
export function laneBox(
  columnIndex: number,
  columnCount: number,
  columnSpan: number,
): { left: number; width: number } {
  if (columnCount <= 1) return { left: 0, width: 1 };
  // Width W and step S solve (columnCount-1)·S + W = 1 with S = ratio·W, so the
  // fan exactly spans the column and the rightmost card ends flush.
  const width = 1 / (1 + (columnCount - 1) * LANE_ADVANCE_RATIO);
  const step = LANE_ADVANCE_RATIO * width;
  return { left: columnIndex * step, width: width + (columnSpan - 1) * step };
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
      return {
        event,
        start,
        end,
        stackIndex: 0,
        stackCount: 1,
        elevation: 0,
        columnIndex: 0,
        columnCount: 1,
        columnSpan: 1,
      };
    })
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

  // Walk events in start order, grouping transitively overlapping ones into
  // clusters (a run of events chained by overlap). Each cluster is laid out
  // independently for both the cascade (week) and the columns (day).
  let cluster: typeof items = [];
  let clusterEnd = -Infinity;

  const closeCluster = () => {
    if (cluster.length === 0) return;
    for (const item of cluster) item.stackCount = cluster.length;

    // Column packing: greedy first-fit into lanes (mirrors layoutAllDayEvents,
    // but on ms ends). Each event reuses the first lane free at its start, or
    // opens a new one.
    const laneEnds: number[] = [];
    for (const item of cluster) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = item.end;
      item.columnIndex = lane;
    }
    const columnCount = laneEnds.length;
    // Expand each card right into free columns: stop at the first later-lane
    // event it overlaps in time.
    for (const item of cluster) {
      item.columnCount = columnCount;
      let span = columnCount - item.columnIndex;
      for (const other of cluster) {
        if (other === item || other.columnIndex <= item.columnIndex) continue;
        if (other.start < item.end && other.end > item.start) {
          span = Math.min(span, other.columnIndex - item.columnIndex);
        }
      }
      item.columnSpan = Math.max(span, 1);
    }

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

  return items.map(
    ({
      event,
      start,
      end,
      stackIndex,
      stackCount,
      elevation,
      columnIndex,
      columnCount,
      columnSpan,
    }) => ({
      event,
      topPct: msToPct(start, dayStartMs),
      heightPct: msToPct(end, dayStartMs) - msToPct(start, dayStartMs),
      stackIndex,
      stackCount,
      elevation,
      columnIndex,
      columnCount,
      columnSpan,
    }),
  );
}

// Event/calendar colors live in ./colors.ts — they resolve against Google's
// synced color data rather than anything derived here.
