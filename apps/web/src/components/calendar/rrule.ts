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
