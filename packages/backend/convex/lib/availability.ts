/**
 * Availability math for public booking pages: turn a weekly schedule plus the
 * host's busy time into the concrete list of instants a visitor may book.
 *
 * Deliberately import-free, like ./permissions.ts. Nothing here touches Convex,
 * so the whole slot pipeline is unit-testable and could be reused by the client
 * if it ever needs to derive slots locally.
 *
 * A host writes their schedule in wall-clock minutes ("Mondays 09:00–17:00"),
 * which only becomes an instant once you know the zone — and the offset changes
 * twice a year. Every conversion therefore goes through `zonedToUtcMs`, and no
 * caller is allowed to reach for the runtime's local zone.
 */

export const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
export const MINUTES_PER_DAY = 24 * 60;

/** One weekly opening. `weekday` is 0 (Sunday) through 6; the bounds are
 * minutes from midnight in the page's zone, and `endMin` may be 1440. */
export interface AvailabilityRule {
  weekday: number;
  startMin: number;
  endMin: number;
}

/** A wall-clock span within one day, in minutes from that day's midnight. */
export interface DayInterval {
  startMin: number;
  endMin: number;
}

/** A single date's replacement for its weekday's rules. Empty = day blocked. */
export interface AvailabilityOverride {
  dateKey: string;
  intervals: DayInterval[];
}

/** A half-open span of absolute time, `[startMs, endMs)`. */
export interface Interval {
  startMs: number;
  endMs: number;
}

// --- Time zones -----------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock fields an instant reads as in `timeZone`. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(new Date(ms));
  const read = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  // h23 still renders midnight as "24" in some ICU versions.
  const hour = read("hour") % 24;
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour,
    minute: read("minute"),
    second: read("second"),
  };
}

/** The zone's UTC offset at `ms`, such that `wallClock = utc + offset`.
 * Negative west of Greenwich (New York in winter is -5h). */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  // Re-read the wall clock as if it were UTC: the gap to the real instant is
  // exactly the offset. Seconds are enough precision — no zone uses sub-second
  // offsets, and the ms remainder cancels out.
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Format a UTC-based instant as a "YYYY-MM-DD" key. */
function toDateKey(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Split a "YYYY-MM-DD" key. Returns null when the shape is wrong, so callers
 * validating user input can reject it rather than compute against NaN. */
export function parseDateKey(
  dateKey: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** How an instant reads in `timeZone`: its calendar day, that day's weekday
 * (0 = Sunday), and how many minutes into the day it falls. */
export function utcToZoned(
  ms: number,
  timeZone: string,
): { dateKey: string; weekday: number; minutes: number } {
  const p = zonedParts(ms, timeZone);
  return {
    dateKey: toDateKey(p.year, p.month, p.day),
    weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(),
    minutes: p.hour * 60 + p.minute,
  };
}

/**
 * The instant at which `minutes` past midnight on `dateKey` occurs in
 * `timeZone`. `minutes` may exceed 1440 to mean the following day (an `endMin`
 * of 1440 is midnight at the end of the day).
 *
 * Two passes: the offset we need is the one *at the answer*, but finding the
 * answer needs the offset. Guess with the offset at the naive instant, then
 * re-resolve at the guess — which is what makes a DST boundary come out right.
 * A wall-clock time that DST skips resolves to the instant the clock jumped to.
 */
export function zonedToUtcMs(
  dateKey: string,
  minutes: number,
  timeZone: string,
): number {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new Error(`Invalid date key: ${dateKey}`);
  const naive =
    Date.UTC(parsed.year, parsed.month - 1, parsed.day) +
    minutes * MS_PER_MINUTE;
  const guess = naive - zoneOffsetMs(naive, timeZone);
  return naive - zoneOffsetMs(guess, timeZone);
}

/** The weekday a date key falls on, 0 (Sunday) through 6. A calendar date has
 * one weekday in every zone, so this needs no zone. */
export function weekdayOfDateKey(dateKey: string): number {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new Error(`Invalid date key: ${dateKey}`);
  return new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day),
  ).getUTCDay();
}

/** Shift a date key by whole days. Pure calendar arithmetic, no zone involved. */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new Error(`Invalid date key: ${dateKey}`);
  const shifted = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day) + days * MS_PER_DAY,
  );
  return toDateKey(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

/** Every date key from `fromKey` to `toKey` inclusive. */
export function dateKeyRange(fromKey: string, toKey: string): string[] {
  const keys: string[] = [];
  let key = fromKey;
  // Bounded so a reversed or absurd range can't spin: no caller needs a year.
  for (let i = 0; i < 400 && key <= toKey; i += 1) {
    keys.push(key);
    key = addDaysToDateKey(key, 1);
  }
  return keys;
}

/**
 * The busy span of an all-day event in `timeZone`. Google stores all-day bounds
 * as UTC-midnight instants with an exclusive end, so reading them as absolute
 * time would slide the block by the zone's offset — a full-day block in Sydney
 * would leak into the neighbouring day. Re-anchor both ends to local midnight.
 */
export function allDayBusyInterval(
  startMs: number,
  endMs: number,
  timeZone: string,
): Interval {
  const startDate = new Date(startMs);
  const endDate = new Date(endMs);
  const startKey = toDateKey(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth() + 1,
    startDate.getUTCDate(),
  );
  const endKey = toDateKey(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth() + 1,
    endDate.getUTCDate(),
  );
  return {
    startMs: zonedToUtcMs(startKey, 0, timeZone),
    endMs: zonedToUtcMs(endKey, 0, timeZone),
  };
}

// --- Interval algebra -----------------------------------------------------

/** Sort and coalesce overlapping or touching intervals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.endMs > i.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** `base` with every part of `cuts` removed. Both are merged first, so the
 * result is itself a sorted, non-overlapping cover. */
export function subtractIntervals(
  base: Interval[],
  cuts: Interval[],
): Interval[] {
  const holes = mergeIntervals(cuts);
  const result: Interval[] = [];
  for (const span of mergeIntervals(base)) {
    let startMs = span.startMs;
    for (const hole of holes) {
      if (hole.endMs <= startMs) continue;
      if (hole.startMs >= span.endMs) break;
      if (hole.startMs > startMs) {
        result.push({ startMs, endMs: hole.startMs });
      }
      startMs = Math.max(startMs, hole.endMs);
      if (startMs >= span.endMs) break;
    }
    if (startMs < span.endMs) result.push({ startMs, endMs: span.endMs });
  }
  return result;
}

/** Clamp intervals to `[startMs, endMs)`, dropping anything outside it. */
export function clampIntervals(
  intervals: Interval[],
  startMs: number,
  endMs: number,
): Interval[] {
  return intervals
    .map((i) => ({
      startMs: Math.max(i.startMs, startMs),
      endMs: Math.min(i.endMs, endMs),
    }))
    .filter((i) => i.endMs > i.startMs);
}

// --- Slot generation ------------------------------------------------------

export interface SlotConfig {
  timeZone: string;
  rules: AvailabilityRule[];
  overrides: AvailabilityOverride[];
  /** Spans the host is already committed to: busy events and live bookings. */
  busy: Interval[];
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  /** The window the caller is asking about. */
  fromMs: number;
  toMs: number;
  nowMs: number;
}

/**
 * The bookable slot starts within `[fromMs, toMs)`, ascending.
 *
 * Open windows come from the weekly rules (or a date's override, which replaces
 * them outright), then everything the host is already committed to is cut out —
 * each busy span widened by `bufferMinutes` on both sides so a booking can never
 * butt up against an existing meeting. Slots step from each surviving window's
 * own start, so a 09:00–17:00 rule with 30-minute slots offers 09:00, 09:30, …
 * and a window that a meeting cuts to 10:15–11:00 offers 10:15 alone.
 */
export function generateSlots(config: SlotConfig): number[] {
  const {
    timeZone,
    rules,
    overrides,
    busy,
    slotMinutes,
    bufferMinutes,
    minNoticeMinutes,
    horizonDays,
    fromMs,
    toMs,
    nowMs,
  } = config;

  if (slotMinutes <= 0) return [];
  const slotMs = slotMinutes * MS_PER_MINUTE;

  const earliestMs = Math.max(fromMs, nowMs + minNoticeMinutes * MS_PER_MINUTE);
  const latestMs = Math.min(toMs, nowMs + horizonDays * MS_PER_DAY);
  if (earliestMs >= latestMs) return [];

  const overrideByDate = new Map(overrides.map((o) => [o.dateKey, o.intervals]));

  // Walk the host's calendar days, padded a day either side: a window sitting
  // near the zone's date boundary belongs to a day just outside the request.
  const firstKey = addDaysToDateKey(utcToZoned(earliestMs, timeZone).dateKey, -1);
  const lastKey = addDaysToDateKey(utcToZoned(latestMs, timeZone).dateKey, 1);

  const windows: Interval[] = [];
  for (const dateKey of dateKeyRange(firstKey, lastKey)) {
    const weekday = weekdayOfDateKey(dateKey);
    const dayIntervals =
      overrideByDate.get(dateKey) ??
      rules.filter((rule) => rule.weekday === weekday);
    for (const interval of dayIntervals) {
      if (interval.endMin <= interval.startMin) continue;
      windows.push({
        startMs: zonedToUtcMs(dateKey, interval.startMin, timeZone),
        endMs: zonedToUtcMs(dateKey, interval.endMin, timeZone),
      });
    }
  }

  const bufferMs = bufferMinutes * MS_PER_MINUTE;
  const blocked = busy.map((b) => ({
    startMs: b.startMs - bufferMs,
    endMs: b.endMs + bufferMs,
  }));

  const free = clampIntervals(
    subtractIntervals(windows, blocked),
    earliestMs,
    latestMs,
  );

  const slots: number[] = [];
  for (const span of free) {
    for (let start = span.startMs; start + slotMs <= span.endMs; start += slotMs) {
      slots.push(start);
    }
  }
  return slots.sort((a, b) => a - b);
}
