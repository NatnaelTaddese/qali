/**
 * Event reminders, provider-neutral.
 *
 * One model for every calendar provider: a reminder is `{ method, minutes }`
 * where `minutes` counts back from the event's anchor — the start instant for a
 * timed event, local midnight of the start date (in the calendar's zone) for an
 * all-day one. Google's `overrides[].minutes`, Microsoft Graph's
 * `reminderMinutesBeforeStart`, and an iCalendar `TRIGGER;RELATED=START` all
 * reduce to that unit, so adapters only translate wire shapes.
 *
 * `undefined` reminders mean "the provider/calendar default applies"; an empty
 * array is an explicit "no reminders". `email` reminders are stored so a
 * write-back never erases them, but only `popup` ones ever fire here.
 *
 * Shared by the backend (ledger, sweep, service validation) and the web client
 * (picker rules, labels), so both agree on every fire instant.
 */

import { zonedToUtcMs } from "./availability";

export const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export const DEFAULT_TIMED_REMINDER_MINUTES: readonly number[] = [10];
/** 09:00 the day before — Google's own all-day default. */
export const DEFAULT_ALL_DAY_REMINDER_MINUTES: readonly number[] = [900];
/** Google's hard cap (4 weeks); used uniformly across providers. */
export const MAX_REMINDER_MINUTES = 40_320;
/** Offsets beyond a week are stored and round-tripped but never fired: the
 * ledger only materialises an 8-day window. */
export const MAX_FIRE_OFFSET_MINUTES = 7 * 24 * 60;
/** Google's per-event override cap; used uniformly as our own. */
export const MAX_REMINDERS_PER_EVENT = 5;
/** A reminder that is late still fires while the event has not started yet
 * (plus this grace); once the event is under way it is noise. */
export const LATE_GRACE_MS = 5 * MS_PER_MINUTE;

export type ReminderMethod = "popup" | "email";

export interface Reminder {
  readonly method: ReminderMethod;
  readonly minutes: number;
}

// --- Per-provider rules ----------------------------------------------------

/** Providers we know how to talk to. The domain keeps its own union so it never
 * imports backend types; unknown strings resolve to the read-only rules. */
export type ReminderProvider = "google" | "microsoft" | "ical";

export interface ReminderRules {
  /** The provider exposes reminders at all. */
  readonly read: boolean;
  /** We may write reminders back (false for read-only ICS subscriptions). */
  readonly write: boolean;
  /** How many reminders one event may carry on the wire. */
  readonly maxPerEvent: number;
  /** Methods the provider can represent. */
  readonly methods: readonly ReminderMethod[];
  /** Whether "use the calendar's default" exists on the wire. When false, the
   * service resolves the default itself and writes an explicit list. */
  readonly providerDefault: boolean;
  readonly maxMinutes: number;
}

export const REMINDER_RULES: Record<ReminderProvider, ReminderRules> = {
  google: {
    read: true,
    write: true,
    maxPerEvent: MAX_REMINDERS_PER_EVENT,
    methods: ["popup", "email"],
    providerDefault: true,
    maxMinutes: MAX_REMINDER_MINUTES,
  },
  // Graph models one reminder: `isReminderOn` + `reminderMinutesBeforeStart`.
  microsoft: {
    read: true,
    write: true,
    maxPerEvent: 1,
    methods: ["popup"],
    providerDefault: false,
    maxMinutes: MAX_REMINDER_MINUTES,
  },
  // Subscribed .ics feeds: VALARMs are read, never written.
  ical: {
    read: true,
    write: false,
    maxPerEvent: MAX_REMINDERS_PER_EVENT,
    methods: ["popup", "email"],
    providerDefault: false,
    maxMinutes: MAX_REMINDER_MINUTES,
  },
};

const UNKNOWN_PROVIDER_RULES: ReminderRules = {
  read: true,
  write: false,
  maxPerEvent: MAX_REMINDERS_PER_EVENT,
  methods: ["popup", "email"],
  providerDefault: false,
  maxMinutes: MAX_REMINDER_MINUTES,
};

export function reminderRulesFor(provider: string): ReminderRules {
  return Object.prototype.hasOwnProperty.call(REMINDER_RULES, provider)
    ? REMINDER_RULES[provider as ReminderProvider]
    : UNKNOWN_PROVIDER_RULES;
}

export class ReminderRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReminderRulesError";
  }
}

/**
 * Shape a requested reminder write to what a provider can hold, or throw when
 * that would silently drop what the user asked for.
 *
 * - `undefined` (leave as is) passes through untouched.
 * - `null` (back to the default) passes through when the provider has a
 *   default concept; otherwise it becomes an explicit popup list built from
 *   `resolvedDefault`, so the provider sees exactly what we would fire.
 * - Unsupported methods are dropped (they could never be represented), minutes
 *   are range-checked, and more popups than `maxPerEvent` is an error rather
 *   than a truncation — a lost reminder is the one failure the user cannot see.
 */
export function fitRemindersToRules(
  reminders: readonly Reminder[] | null | undefined,
  rules: ReminderRules,
  resolvedDefault: readonly number[],
): Reminder[] | null | undefined {
  if (reminders === undefined) return undefined;
  if (!rules.write) {
    throw new ReminderRulesError(
      "Reminders can't be changed on this calendar",
    );
  }
  if (reminders === null) {
    if (rules.providerDefault) return null;
    return resolvedDefault
      .slice(0, rules.maxPerEvent)
      .map((minutes) => ({ method: "popup" as const, minutes }));
  }
  const kept = dedupeReminders(
    reminders.filter((r) => rules.methods.includes(r.method)),
  );
  for (const r of kept) {
    if (!Number.isInteger(r.minutes) || r.minutes < 0) {
      throw new ReminderRulesError("Reminder offset out of range");
    }
    if (r.minutes > rules.maxMinutes) {
      throw new ReminderRulesError(
        `Reminders can be at most ${rules.maxMinutes / 1440} days before`,
      );
    }
  }
  if (kept.length > rules.maxPerEvent) {
    throw new ReminderRulesError(
      rules.maxPerEvent === 1
        ? "This calendar supports one reminder per event"
        : `This calendar supports up to ${rules.maxPerEvent} reminders per event`,
    );
  }
  return kept;
}

function reminderKey(r: Reminder): string {
  return `${r.method}:${r.minutes}`;
}

/** Order-insensitive, duplicate-insensitive equality; `null`/`undefined` only
 * equal themselves. Every adapter's idempotent no-op check goes through this. */
export function sameReminderSets(
  a: readonly Reminder[] | null | undefined,
  b: readonly Reminder[] | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = new Set(a.map(reminderKey));
  const right = new Set(b.map(reminderKey));
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

/** Deduped by (method, minutes), sorted by minutes then method. */
export function dedupeReminders(list: readonly Reminder[]): Reminder[] {
  const seen = new Map<string, Reminder>();
  for (const r of list) {
    const key = reminderKey(r);
    if (!seen.has(key)) seen.set(key, { method: r.method, minutes: r.minutes });
  }
  return [...seen.values()].sort(
    (x, y) => x.minutes - y.minutes || x.method.localeCompare(y.method),
  );
}

// --- Resolution --------------------------------------------------------------

/** Integer offsets in range, deduped and ascending; throws on bad input. Used
 * to validate preference lists and the popup subset of an event's list. */
export function normalizeReminderMinutes(list: readonly number[]): number[] {
  const out = new Set<number>();
  for (const m of list) {
    if (!Number.isInteger(m) || m < 0 || m > MAX_REMINDER_MINUTES) {
      throw new ReminderRulesError("Reminder offset out of range");
    }
    out.add(m);
  }
  if (out.size > MAX_REMINDERS_PER_EVENT) {
    throw new ReminderRulesError(
      `At most ${MAX_REMINDERS_PER_EVENT} reminders per event`,
    );
  }
  return [...out].sort((a, b) => a - b);
}

function dedupeSorted(list: readonly number[]): number[] {
  return [...new Set(list)].sort((a, b) => a - b);
}

function popupMinutes(list: readonly Reminder[]): number[] {
  return dedupeSorted(
    list.filter((r) => r.method === "popup").map((r) => r.minutes),
  );
}

/**
 * Which popup offsets an event fires with:
 * 1. The event's own list, when it has one (may be empty = none).
 * 2. All-day: the user's all-day default, else 09:00 the day before.
 * 3. The user's timed default, else the calendar's provider default, else
 *    10 minutes.
 *
 * The user's preference sits above the provider's calendar default on purpose:
 * Google returns `defaultReminders` for every calendar (often empty), so a
 * preference that only applied when the provider sent nothing would never take
 * effect. No preference = mirror the provider exactly.
 */
export function resolvePopupMinutes(args: {
  readonly eventReminders?: readonly Reminder[];
  readonly allDay: boolean;
  readonly calendarDefaults?: readonly Reminder[];
  readonly preferredMinutes?: readonly number[];
  readonly preferredAllDayMinutes?: readonly number[];
}): number[] {
  if (args.eventReminders !== undefined) {
    return popupMinutes(args.eventReminders);
  }
  if (args.allDay) {
    return dedupeSorted(
      args.preferredAllDayMinutes ?? DEFAULT_ALL_DAY_REMINDER_MINUTES,
    );
  }
  if (args.preferredMinutes !== undefined) {
    return dedupeSorted(args.preferredMinutes);
  }
  if (args.calendarDefaults !== undefined) {
    return popupMinutes(args.calendarDefaults);
  }
  return [...DEFAULT_TIMED_REMINDER_MINUTES];
}

// --- Fire instants -------------------------------------------------------------

/** An all-day event's `startMs` is UTC midnight of a floating date; recover
 * the date key. */
export function allDayDateKey(startMs: number): string {
  return new Date(startMs).toISOString().slice(0, 10);
}

/** The instant the event's anchor falls on: its start, or local midnight of
 * its date in `timeZone` for an all-day event. */
export function reminderAnchorMs(args: {
  readonly startMs: number;
  readonly allDay: boolean;
  readonly timeZone: string;
}): number {
  return args.allDay
    ? zonedToUtcMs(allDayDateKey(args.startMs), 0, args.timeZone)
    : args.startMs;
}

/** When a reminder fires. All-day follows Google's convention, so 900 minutes
 * is 09:00 the day before in the calendar's zone. */
export function reminderFireAtMs(args: {
  readonly startMs: number;
  readonly allDay: boolean;
  readonly minutes: number;
  readonly timeZone: string;
}): number {
  return reminderAnchorMs(args) - args.minutes * MS_PER_MINUTE;
}

/** A due reminder is still worth showing while the event has not started (a
 * 12-hour-late "tomorrow at 9" reminder is still useful); after that it's
 * noise. */
export function reminderStillUseful(args: {
  readonly fireAtMs: number;
  readonly eventStartMs: number;
  readonly allDay: boolean;
  readonly timeZone: string;
  readonly nowMs: number;
}): boolean {
  if (args.fireAtMs >= args.nowMs) return true;
  const start = reminderAnchorMs({
    startMs: args.eventStartMs,
    allDay: args.allDay,
    timeZone: args.timeZone,
  });
  return start + LATE_GRACE_MS > args.nowMs;
}

export interface PlannedReminder {
  readonly minutes: number;
  readonly fireAtMs: number;
}

/** Everything the ledger needs for one event: each fireable offset with its
 * instant, dropping offsets we never fire and ones already past their use. */
export function plannedReminders(args: {
  readonly startMs: number;
  readonly allDay: boolean;
  readonly timeZone: string;
  readonly minutes: readonly number[];
  readonly nowMs: number;
}): PlannedReminder[] {
  const anchor = reminderAnchorMs(args);
  return dedupeSorted(args.minutes)
    .filter((m) => m <= MAX_FIRE_OFFSET_MINUTES)
    .map((m) => ({ minutes: m, fireAtMs: anchor - m * MS_PER_MINUTE }))
    .filter(
      (r) =>
        r.fireAtMs >= args.nowMs || anchor + LATE_GRACE_MS > args.nowMs,
    );
}

/** The ledger materialises events whose start lies in this window around now.
 * Lookback covers all-day rows (UTC-midnight `startMs` can sit up to ~14h
 * before local midnight); lookahead is the largest fired offset plus a day. */
export const MATERIALIZE_LOOKBACK_MS = 1 * MS_PER_DAY;
export const MATERIALIZE_LOOKAHEAD_MS = 8 * MS_PER_DAY;
