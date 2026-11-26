/** Pure event-contract helpers shared by assistant preview and application. */

import {
  addDaysToDateKey,
  utcToZoned,
  zonedToUtcMs,
} from "@qali/domain/availability";

export interface AssistantTimedRange {
  kind: "timed";
  startMs: number;
  endMs: number;
}

export interface AssistantAllDayRange {
  kind: "allDay";
  /** Calendar date as written by the user. */
  startDate: string;
  /** Exclusive calendar end date, matching Google Calendar's API. */
  endDate: string;
}

export type AssistantEventRange = AssistantTimedRange | AssistantAllDayRange;

export const ASSISTANT_WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type AssistantWeekday = (typeof ASSISTANT_WEEKDAYS)[number];

export type AssistantRepeatEnd =
  | { kind: "never" }
  | { kind: "onDate"; date: string }
  | { kind: "count"; count: number };

type AssistantRepeatBase = {
  interval?: number;
  end?: AssistantRepeatEnd;
};

export type AssistantRepeat =
  | (AssistantRepeatBase & { frequency: "daily" })
  | (AssistantRepeatBase & {
      frequency: "weekly";
      weekdays: AssistantWeekday[];
    })
  | (AssistantRepeatBase & { frequency: "monthly" })
  | (AssistantRepeatBase & { frequency: "yearly" });

const WEEKDAY_CODE: Record<AssistantWeekday, string> = {
  monday: "MO",
  tuesday: "TU",
  wednesday: "WE",
  thursday: "TH",
  friday: "FR",
  saturday: "SA",
  sunday: "SU",
};

const DATE_WEEKDAY: AssistantWeekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  // Reject syntactically-valid but nonexistent dates (e.g. 2023-02-29):
  // `toISOString()` throws on an Invalid Date, so bail out before formatting.
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

/** The widest span a read tool will resolve, in calendar days. Wider asks are
 * refused rather than silently truncated, so the model narrows the range. */
export const MAX_LOOKUP_DAYS = 92;

/**
 * Turn inclusive local calendar dates into the instants that bound them.
 *
 * The read tools take dates rather than epoch milliseconds because models get
 * local midnight wrong: asked for "today" in Los Angeles they reliably send UTC
 * midnight, which drops every evening event. Doing the zone maths here means
 * the model only has to name the day it can already read off its clock line.
 * `toMs` is the following local midnight, so the range is half-open and a DST
 * day comes out 23 or 25 hours long.
 */
export function localDateRange(
  fromDate: string,
  toDate: string,
  timeZone: string,
): { fromMs: number; toMs: number; days: string[] } {
  if (!isDateKey(fromDate) || !isDateKey(toDate)) {
    throw new Error("Use real calendar dates in YYYY-MM-DD form");
  }
  if (toDate < fromDate) {
    throw new Error("toDate must be on or after fromDate");
  }
  const days: string[] = [];
  for (let key = fromDate; key <= toDate; key = addDaysToDateKey(key, 1)) {
    if (days.length === MAX_LOOKUP_DAYS) {
      throw new Error(
        `That range is longer than ${MAX_LOOKUP_DAYS} days. Ask for a shorter one.`,
      );
    }
    days.push(key);
  }
  return {
    fromMs: zonedToUtcMs(fromDate, 0, timeZone),
    toMs: zonedToUtcMs(addDaysToDateKey(toDate, 1), 0, timeZone),
    days,
  };
}

export function validateAssistantRange(range: AssistantEventRange): boolean {
  if (range.kind === "timed") {
    return (
      Number.isFinite(range.startMs) &&
      Number.isFinite(range.endMs) &&
      range.endMs > range.startMs
    );
  }
  return (
    isDateKey(range.startDate) &&
    isDateKey(range.endDate) &&
    range.endDate > range.startDate
  );
}

/** Convert the date-only contract to the UTC-midnight representation used by
 * synced Google date values. The date text itself, not a user's UTC offset,
 * determines the resulting Google payload. */
export function assistantRangeToEventTime(range: AssistantEventRange): {
  startMs: number;
  endMs: number;
  allDay: boolean;
} {
  if (!validateAssistantRange(range)) {
    throw new Error("The event must end after it starts");
  }
  return range.kind === "allDay"
    ? {
        startMs: Date.parse(`${range.startDate}T00:00:00.000Z`),
        endMs: Date.parse(`${range.endDate}T00:00:00.000Z`),
        allDay: true,
      }
    : { startMs: range.startMs, endMs: range.endMs, allDay: false };
}

function assistantRangeStartDate(
  range: AssistantEventRange,
  timeZone: string,
): string {
  return range.kind === "allDay"
    ? range.startDate
    : utcToZoned(range.startMs, timeZone).dateKey;
}

function rruleTimestamp(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}T${iso
    .slice(11, 19)
    .replaceAll(":", "")}Z`;
}

/** Compile the small, model-facing recurrence contract into the single RRULE
 * Google expects. The event range supplies DTSTART separately; validating that
 * its first date belongs to a weekly rule avoids a subtly shifted series. */
export function assistantRepeatToRRule(
  repeat: AssistantRepeat,
  range: AssistantEventRange,
  timeZone: string,
): string[] {
  const interval = repeat.interval ?? 1;
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new Error("The repeat interval must be a positive integer");
  }

  const startDate = assistantRangeStartDate(range, timeZone);
  if (repeat.frequency === "weekly") {
    const weekdays = [...new Set(repeat.weekdays)];
    if (weekdays.length === 0) {
      throw new Error("A weekly repeat needs at least one weekday");
    }
    const startWeekday = DATE_WEEKDAY[
      new Date(`${startDate}T00:00:00.000Z`).getUTCDay()
    ];
    if (!weekdays.includes(startWeekday)) {
      throw new Error("The first occurrence must fall on one of the repeating weekdays");
    }
  }

  const frequency = repeat.frequency.toUpperCase();
  const parts = [`FREQ=${frequency}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (repeat.frequency === "weekly") {
    const selected = new Set(repeat.weekdays);
    parts.push(
      `BYDAY=${ASSISTANT_WEEKDAYS.filter((day) => selected.has(day))
        .map((day) => WEEKDAY_CODE[day])
        .join(",")}`,
    );
  }

  const end = repeat.end ?? { kind: "never" as const };
  if (end.kind === "count") {
    if (!Number.isSafeInteger(end.count) || end.count < 1) {
      throw new Error("The repeat count must be a positive integer");
    }
    parts.push(`COUNT=${end.count}`);
  } else if (end.kind === "onDate") {
    if (!isDateKey(end.date) || end.date < startDate) {
      throw new Error("The repeat end date must be on or after the first occurrence");
    }
    const until =
      range.kind === "allDay"
        ? end.date.replaceAll("-", "")
        : rruleTimestamp(
            zonedToUtcMs(addDaysToDateKey(end.date, 1), 0, timeZone) - 1_000,
          );
    parts.push(`UNTIL=${until}`);
  }

  return [`RRULE:${parts.join(";")}`];
}

/** Compact wording for proposal cards; unlike the old raw RRULE preview, this
 * is useful to a person deciding whether to confirm the change. */
export function formatAssistantRepeat(
  repeat: AssistantRepeat,
  range: AssistantEventRange,
  timeZone: string,
): string {
  const interval = repeat.interval ?? 1;
  const startDate = assistantRangeStartDate(range, timeZone);
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const unit: Record<AssistantRepeat["frequency"], string> = {
    daily: "day",
    weekly: "week",
    monthly: "month",
    yearly: "year",
  };
  let summary =
    interval === 1
      ? repeat.frequency === "daily"
        ? "daily"
        : repeat.frequency === "weekly"
          ? "weekly"
          : repeat.frequency === "monthly"
            ? `monthly on day ${start.getUTCDate()}`
            : `yearly on ${new Intl.DateTimeFormat("en-US", {
                timeZone: "UTC",
                month: "short",
                day: "numeric",
              }).format(start)}`
      : `every ${interval} ${unit[repeat.frequency]}s`;
  if (repeat.frequency === "weekly") {
    summary += ` on ${ASSISTANT_WEEKDAYS.filter((day) =>
      repeat.weekdays.includes(day),
    ).join(", ")}`;
  }
  const end = repeat.end ?? { kind: "never" as const };
  if (end.kind === "count") summary += ` for ${end.count} occurrences`;
  if (end.kind === "onDate") summary += ` through ${end.date}`;
  if (end.kind === "never") summary += " with no end";
  return summary;
}

function formatDateKey(dateKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${dateKey}T00:00:00.000Z`));
}

export function formatAssistantAllDayRange(
  startDate: string,
  endDate: string,
): string {
  if (!isDateKey(startDate) || !isDateKey(endDate) || endDate <= startDate) {
    throw new Error("The all-day event must have a valid exclusive end date");
  }
  const lastDay = new Date(Date.parse(`${endDate}T00:00:00.000Z`) - 1)
    .toISOString()
    .slice(0, 10);
  return startDate === lastDay
    ? `${formatDateKey(startDate)} (all day)`
    : `${formatDateKey(startDate)}–${formatDateKey(lastDay)} (all day)`;
}

// --- Local wall-clock times ------------------------------------------------

/** A timed range the way the model states it: a local calendar date and
 * 24-hour wall-clock times in the user's zone. The server turns it into
 * instants, so the model never does epoch or offset arithmetic. */
export interface AssistantLocalTimedRange {
  kind: "timed";
  date: string;
  start: string;
  end: string;
  /** The local date the event ends on, when it isn't `date`. */
  endDate?: string;
}

/** Minutes past midnight for "HH:mm" (24-hour), or null. "24:00" is the end
 * of the day. */
export function parseClockTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

/**
 * The instants of a local timed range in `timeZone`. Without an `endDate`,
 * an end at or before the start means the next day ("23:00"–"01:00"); a
 * zero-length range is refused.
 */
export function localTimedRangeToInstants(
  range: AssistantLocalTimedRange,
  timeZone: string,
): AssistantTimedRange {
  if (!isDateKey(range.date) || (range.endDate !== undefined && !isDateKey(range.endDate))) {
    throw new Error("Use real calendar dates in YYYY-MM-DD form");
  }
  const startMin = parseClockTime(range.start);
  const endMin = parseClockTime(range.end);
  if (startMin === null || endMin === null) {
    throw new Error('Use 24-hour local times like "09:30" or "17:00"');
  }
  let endDate = range.endDate ?? range.date;
  if (range.endDate === undefined && endMin <= startMin) {
    if (endMin === startMin) throw new Error("The event must end after it starts");
    endDate = addDaysToDateKey(range.date, 1);
  }
  const startMs = zonedToUtcMs(range.date, startMin, timeZone);
  const endMs = zonedToUtcMs(endDate, endMin, timeZone);
  if (endMs <= startMs) throw new Error("The event must end after it starts");
  return { kind: "timed", startMs, endMs };
}

/** "HH:mm" in `timeZone`, 24-hour. */
export function localClockTime(ms: number, timeZone: string): string {
  const minutes = utcToZoned(ms, timeZone).minutes;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The local date, start and end of a timed instant range, in the shape the
 * write tools take back, so a looked-up time can be passed on unchanged. */
export function instantsToLocalTimed(
  startMs: number,
  endMs: number,
  timeZone: string,
): { date: string; start: string; end: string; endDate?: string } {
  const date = utcToZoned(startMs, timeZone).dateKey;
  const lastDate = utcToZoned(endMs, timeZone).dateKey;
  const end = localClockTime(endMs, timeZone);
  // Ending exactly at the next midnight reads as 24:00 on the same day.
  if (lastDate === addDaysToDateKey(date, 1) && end === "00:00") {
    return { date, start: localClockTime(startMs, timeZone), end: "24:00" };
  }
  return {
    date,
    start: localClockTime(startMs, timeZone),
    end,
    ...(lastDate === date ? {} : { endDate: lastDate }),
  };
}

// --- The calendar the model reads -------------------------------------------

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The next fortnight as weekday-and-date pairs, with this week's bounds by
 * the user's own week start. A model without a reasoning pass gets weekday
 * arithmetic wrong ("next Tuesday" a week off); reading the answer off a
 * list it doesn't have to compute.
 */
export function upcomingDatesLine(
  todayKey: string,
  weekStartsOn: 0 | 1 | 6 = 1,
): string {
  const weekday = (key: string) => new Date(`${key}T00:00:00.000Z`).getUTCDay();
  const offset = (weekday(todayKey) - weekStartsOn + 7) % 7;
  const weekStart = addDaysToDateKey(todayKey, -offset);
  const weekEnd = addDaysToDateKey(weekStart, 6);
  const days: string[] = [];
  for (let i = 0; i < 14; i += 1) {
    const key = addDaysToDateKey(todayKey, i);
    const label = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    days.push(`${WEEKDAY_SHORT[weekday(key)]} ${key}${label}`);
  }
  return (
    `This week runs ${WEEKDAY_SHORT[weekday(weekStart)]} ${weekStart} to ` +
    `${WEEKDAY_SHORT[weekday(weekEnd)]} ${weekEnd}; next week is the seven days after. ` +
    `Upcoming dates: ${days.join(", ")}.`
  );
}
