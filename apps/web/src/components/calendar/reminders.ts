/**
 * Reminder presets and labels for the event form, in the `rrule.ts`
 * `summarize` spirit: pure, zone-free, unit-tested. The math (fire instants,
 * default resolution, per-provider rules) lives in @qali/domain/reminders;
 * this file only decides what the picker offers and how a value reads.
 */

import {
  MAX_REMINDER_MINUTES,
  MAX_REMINDERS_PER_EVENT,
  dedupeReminders,
  sameReminderSets,
  type Reminder,
} from "@qali/domain/reminders";

export type { Reminder };
export { MAX_REMINDERS_PER_EVENT };

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** Offsets before a timed event's start. */
export const TIMED_PRESETS: readonly number[] = [
  0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10_080,
];

/**
 * All-day offsets count back from local midnight of the start date, and a
 * provider forbids negative offsets, so "on the day at 09:00" cannot exist.
 * What's left is "N days before at HH:MM": the evening before, the morning
 * before (the provider default), two days before, a week before.
 */
export const ALL_DAY_PRESETS: readonly number[] = [
  allDayMinutes(1, 9 * 60), // the day before at 09:00
  allDayMinutes(1, 18 * 60), // the day before at 18:00
  allDayMinutes(2, 9 * 60), // two days before at 09:00
  allDayMinutes(7, 9 * 60), // a week before at 09:00
];

/** Minutes before midnight for "`days` before at `timeOfDay` minutes". */
export function allDayMinutes(days: number, timeOfDay: number): number {
  return Math.max(0, Math.min(MAX_REMINDER_MINUTES, days * MINUTES_PER_DAY - timeOfDay));
}

/** The inverse: which day and wall-clock time an all-day offset lands on.
 * 900 → the day before (1) at 09:00 (540); 0 → the day itself at midnight. */
export function splitAllDay(minutes: number): { days: number; timeOfDay: number } {
  const days = Math.ceil(minutes / MINUTES_PER_DAY);
  return { days, timeOfDay: days * MINUTES_PER_DAY - minutes };
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function formatTimeOfDay(minutes: number, use24h: boolean): string {
  const h = Math.floor(minutes / MINUTES_PER_HOUR);
  const m = minutes % MINUTES_PER_HOUR;
  const mm = String(m).padStart(2, "0");
  if (use24h) return `${String(h).padStart(2, "0")}:${mm}`;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${period}`;
}

export function daysBeforeLabel(days: number): string {
  if (days <= 0) return "On the day";
  if (days === 1) return "The day before";
  if (days === 7) return "A week before";
  return `${days} days before`;
}

/** "10 min before", "1 hour before", "The day before at 9:00 AM". */
export function labelFor(minutes: number, allDay: boolean, use24h: boolean): string {
  if (allDay) {
    const { days, timeOfDay } = splitAllDay(minutes);
    return `${daysBeforeLabel(days)} at ${formatTimeOfDay(timeOfDay, use24h)}`;
  }
  if (minutes === 0) return "At time of event";
  if (minutes % MINUTES_PER_WEEK === 0) {
    return `${plural(minutes / MINUTES_PER_WEEK, "week")} before`;
  }
  if (minutes % MINUTES_PER_DAY === 0) {
    return `${plural(minutes / MINUTES_PER_DAY, "day")} before`;
  }
  if (minutes % MINUTES_PER_HOUR === 0) {
    return `${plural(minutes / MINUTES_PER_HOUR, "hour")} before`;
  }
  return `${minutes} min before`;
}

/** What the picker's trigger reads. `null` is "use the default". */
export function summarizeReminders(
  reminders: readonly Reminder[] | null,
  allDay: boolean,
  use24h: boolean,
  defaultMinutes?: readonly number[],
): string {
  if (reminders === null) {
    if (!defaultMinutes || defaultMinutes.length === 0) return "Default";
    const first = labelFor(defaultMinutes[0]!, allDay, use24h);
    return defaultMinutes.length === 1
      ? `Default · ${first}`
      : `Default · ${first} +${defaultMinutes.length - 1}`;
  }
  const popups = reminders.filter((r) => r.method === "popup");
  if (popups.length === 0) return "None";
  if (popups.length === 1) return labelFor(popups[0]!.minutes, allDay, use24h);
  return `${popups.length} reminders`;
}

/** Deduped, sorted, in range, and capped — what the form sends. */
export function normalizeReminders(reminders: readonly Reminder[]): Reminder[] {
  return dedupeReminders(
    reminders.filter(
      (r) =>
        Number.isInteger(r.minutes) &&
        r.minutes >= 0 &&
        r.minutes <= MAX_REMINDER_MINUTES,
    ),
  ).slice(0, MAX_REMINDERS_PER_EVENT);
}

/** Order-insensitive equality with `null` only equal to itself. */
export function sameReminders(
  a: readonly Reminder[] | null,
  b: readonly Reminder[] | null,
): boolean {
  return sameReminderSets(a, b);
}

/** Toggle one popup offset in a list. */
export function togglePopup(reminders: readonly Reminder[], minutes: number): Reminder[] {
  const has = reminders.some((r) => r.method === "popup" && r.minutes === minutes);
  return has
    ? reminders.filter((r) => !(r.method === "popup" && r.minutes === minutes))
    : dedupeReminders([...reminders, { method: "popup", minutes }]);
}

export function hasPopup(reminders: readonly Reminder[] | null, minutes: number): boolean {
  return (
    reminders?.some((r) => r.method === "popup" && r.minutes === minutes) ?? false
  );
}

export type CustomUnit = "min" | "hours" | "days" | "weeks";

export const CUSTOM_UNIT_MINUTES: Record<CustomUnit, number> = {
  min: 1,
  hours: MINUTES_PER_HOUR,
  days: MINUTES_PER_DAY,
  weeks: MINUTES_PER_WEEK,
};
