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
