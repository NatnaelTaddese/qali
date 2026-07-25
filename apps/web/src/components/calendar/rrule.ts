// A small, dependency-free RFC5545 recurrence model. We only ever *emit* rules
// (Google is the source of truth and syncs expanded instances back), so there is
// no parser here — just a typed model, a string builder, and a human summary.
import { format } from "date-fns";

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

/** Weekdays in display order (Monday first, matching the calendar grid). */
export const WEEKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** getDay() (0=Sun) → RRULE weekday code. */
const DAY_CODES: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const WEEKDAY_LABEL: Record<Weekday, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};

const FREQ_NOUN: Record<Freq, string> = {
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
  YEARLY: "year",
};

export type RecurrenceEnd =
  | { kind: "never" }
  /** Repeat until (and including) this calendar day. */
  | { kind: "onDate"; dateMs: number }
  | { kind: "count"; count: number };

export interface Recurrence {
  freq: Freq;
  /** "every N" — always >= 1. */
  interval: number;
  /** WEEKLY only; the days the event repeats on. */
  byWeekday?: Weekday[];
  end: RecurrenceEnd;
}

/** Parse the subset of an RFC5545 RRULE that this UI can create and describe.
 * Other recurrence lines (such as EXDATE) do not change the broad summary. */
export function parseRRule(lines: string[]): Recurrence | null {
  const line = lines.find((candidate) => candidate.startsWith("RRULE:"));
  if (!line) return null;

  const fields = new Map<string, string>();
  for (const part of line.slice("RRULE:".length).split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (!value || fields.has(key)) return null;
    fields.set(key, value);
  }

  const supported = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"]);
  if ([...fields.keys()].some((key) => !supported.has(key))) return null;

  const freq = fields.get("FREQ");
  if (!isFreq(freq)) return null;

  const intervalText = fields.get("INTERVAL");
  const interval = intervalText === undefined ? 1 : positiveInteger(intervalText);
  if (interval === null) return null;

  const byDayText = fields.get("BYDAY");
  let byWeekday: Weekday[] | undefined;
  if (byDayText !== undefined) {
    if (freq !== "WEEKLY") return null;
    const days = byDayText.split(",");
    if (days.length === 0 || days.some((day) => !isWeekday(day))) return null;
    byWeekday = [...new Set(days)] as Weekday[];
  }

  const countText = fields.get("COUNT");
  const untilText = fields.get("UNTIL");
  if (countText !== undefined && untilText !== undefined) return null;

  let end: RecurrenceEnd = { kind: "never" };
  if (countText !== undefined) {
    const count = positiveInteger(countText);
    if (count === null) return null;
    end = { kind: "count", count };
  } else if (untilText !== undefined) {
    const dateMs = parseUntilDate(untilText);
    if (dateMs === null) return null;
    end = { kind: "onDate", dateMs };
  }

  return { freq, interval, byWeekday, end };
}

/** The RRULE weekday code for a timestamp's calendar day. */
export function weekdayOf(ms: number): Weekday {
  return DAY_CODES[new Date(ms).getDay()];
}

/** A sensible default recurrence for a preset "Custom…" entry point. */
export function defaultRecurrence(startMs: number): Recurrence {
  return {
    freq: "WEEKLY",
    interval: 1,
    byWeekday: [weekdayOf(startMs)],
    end: { kind: "never" },
  };
}

/** Sort weekday codes into Monday-first display order. */
export function sortWeekdays(days: Weekday[]): Weekday[] {
  return WEEKDAYS.filter((d) => days.includes(d));
}

/** Build the Google `recurrence` array (a single RRULE line) for a model. */
export function toRRule(r: Recurrence): string[] {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) {
    parts.push(`INTERVAL=${r.interval}`);
  }
  if (r.freq === "WEEKLY" && r.byWeekday && r.byWeekday.length > 0) {
    parts.push(`BYDAY=${sortWeekdays(r.byWeekday).join(",")}`);
  }
  if (r.end.kind === "count") {
    parts.push(`COUNT=${Math.max(1, r.end.count)}`);
  } else if (r.end.kind === "onDate") {
    // UNTIL is inclusive; pin it to end-of-day UTC so the chosen day counts.
    const d = new Date(r.end.dateMs);
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(
      d.getDate(),
    )}T235959Z`;
    parts.push(`UNTIL=${stamp}`);
  }
  return [`RRULE:${parts.join(";")}`];
}

const FREQ_ADVERB: Record<Freq, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  YEARLY: "Annually",
};

/** Short human description, e.g. "Weekly on Mon, Wed · 5 times". */
export function summarize(r: Recurrence): string {
  let base =
    r.interval > 1
      ? `Every ${r.interval} ${FREQ_NOUN[r.freq]}s`
      : FREQ_ADVERB[r.freq];
  if (r.freq === "WEEKLY" && r.byWeekday && r.byWeekday.length > 0) {
    const days = sortWeekdays(r.byWeekday)
      .map((d) => WEEKDAY_LABEL[d])
      .join(", ");
    base += ` on ${days}`;
  }
  if (r.end.kind === "count") {
    base += ` · ${r.end.count} time${r.end.count === 1 ? "" : "s"}`;
  } else if (r.end.kind === "onDate") {
    base += ` · until ${format(r.end.dateMs, "MMM d, yyyy")}`;
  }
  return base;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isFreq(value: string | undefined): value is Freq {
  return (
    value === "DAILY" ||
    value === "WEEKLY" ||
    value === "MONTHLY" ||
    value === "YEARLY"
  );
}

function isWeekday(value: string): value is Weekday {
  return WEEKDAYS.includes(value as Weekday);
}

function positiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** UNTIL may be a date or UTC date-time. The control selects a calendar date,
 * so preserve its YYYYMMDD portion rather than shifting it through a timezone. */
function parseUntilDate(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T\d{6}Z)?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date.getTime();
}
