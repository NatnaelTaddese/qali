// @ts-expect-error Bun supplies its test module at runtime; the Convex
// TypeScript project intentionally does not include Bun's ambient types.
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ALL_DAY_REMINDER_MINUTES,
  DEFAULT_TIMED_REMINDER_MINUTES,
  LATE_GRACE_MS,
  MS_PER_MINUTE,
  PLAN_LATE_GRACE_MS,
  REMINDER_RULES,
  ReminderRulesError,
  allDayDateKey,
  dedupeReminders,
  fitRemindersToRules,
  normalizeReminderMinutes,
  plannedReminders,
  reminderFireAtMs,
  reminderRulesFor,
  reminderStillUseful,
  resolvePopupMinutes,
  sameReminderSets,
  type Reminder,
} from "./reminders";

const popup = (minutes: number): Reminder => ({ method: "popup", minutes });
const email = (minutes: number): Reminder => ({ method: "email", minutes });

describe("reminderRulesFor", () => {
  test("known providers return their table entry", () => {
    expect(reminderRulesFor("google")).toBe(REMINDER_RULES.google);
    expect(reminderRulesFor("microsoft")).toBe(REMINDER_RULES.microsoft);
    expect(reminderRulesFor("ical")).toBe(REMINDER_RULES.ical);
  });

  test("unknown providers are readable but never writable", () => {
    const rules = reminderRulesFor("caldav");
    expect(rules.read).toBe(true);
    expect(rules.write).toBe(false);
    // Prototype keys must not leak through as providers.
    expect(reminderRulesFor("toString").write).toBe(false);
  });
});

describe("fitRemindersToRules", () => {
  test("undefined always passes through (nothing to write)", () => {
    expect(fitRemindersToRules(undefined, REMINDER_RULES.ical, [10])).toBe(
      undefined,
    );
  });

  test("google keeps up to five, email included, and null stays null", () => {
    const list = [popup(10), email(30), popup(60), popup(1440), popup(0)];
    expect(fitRemindersToRules(list, REMINDER_RULES.google, [10])).toEqual([
      popup(0),
      popup(10),
      email(30),
      popup(60),
      popup(1440),
    ]);
    expect(fitRemindersToRules(null, REMINDER_RULES.google, [10])).toBe(null);
  });

  test("google rejects a sixth reminder rather than dropping one", () => {
    const six = [0, 5, 10, 15, 30, 60].map(popup);
    expect(() =>
      fitRemindersToRules(six, REMINDER_RULES.google, [10]),
    ).toThrow(ReminderRulesError);
  });

  test("microsoft drops email, allows one popup, and materialises null", () => {
    expect(
      fitRemindersToRules([email(30), popup(15)], REMINDER_RULES.microsoft, [
        10,
      ]),
    ).toEqual([popup(15)]);
    expect(
      fitRemindersToRules(null, REMINDER_RULES.microsoft, [10, 60]),
    ).toEqual([popup(10)]);
    expect(fitRemindersToRules([], REMINDER_RULES.microsoft, [10])).toEqual(
      [],
    );
    expect(() =>
      fitRemindersToRules([popup(10), popup(60)], REMINDER_RULES.microsoft, [
        10,
      ]),
    ).toThrow("one reminder per event");
  });

  test("read-only providers refuse every write, including null", () => {
    expect(() =>
      fitRemindersToRules([popup(10)], REMINDER_RULES.ical, [10]),
    ).toThrow("can't be changed");
    expect(() => fitRemindersToRules(null, reminderRulesFor("x"), [10])).toThrow(
      ReminderRulesError,
    );
  });

  test("range checks", () => {
    expect(() =>
      fitRemindersToRules([popup(-1)], REMINDER_RULES.google, [10]),
    ).toThrow("out of range");
    expect(() =>
      fitRemindersToRules([popup(1.5)], REMINDER_RULES.google, [10]),
    ).toThrow("out of range");
    expect(() =>
      fitRemindersToRules([popup(40_321)], REMINDER_RULES.google, [10]),
    ).toThrow("at most 28 days");
  });

  test("duplicates collapse before the cap is applied", () => {
    expect(
      fitRemindersToRules([popup(10), popup(10)], REMINDER_RULES.microsoft, [
        10,
      ]),
    ).toEqual([popup(10)]);
  });
});

describe("sameReminderSets / dedupeReminders", () => {
  test("order and duplicates do not matter; null and undefined are distinct", () => {
    expect(sameReminderSets([popup(10), email(30)], [email(30), popup(10)])).toBe(
      true,
    );
    expect(sameReminderSets([popup(10), popup(10)], [popup(10)])).toBe(true);
    expect(sameReminderSets([popup(10)], [email(10)])).toBe(false);
    expect(sameReminderSets([], [])).toBe(true);
    expect(sameReminderSets(null, null)).toBe(true);
    expect(sameReminderSets(undefined, undefined)).toBe(true);
    expect(sameReminderSets(null, undefined)).toBe(false);
    expect(sameReminderSets(null, [])).toBe(false);
  });

  test("dedupeReminders sorts by minutes then method", () => {
    expect(dedupeReminders([email(10), popup(10), popup(5), popup(10)])).toEqual([
      popup(5),
      email(10),
      popup(10),
    ]);
  });
});

describe("normalizeReminderMinutes", () => {
  test("dedupes, sorts and range-checks", () => {
    expect(normalizeReminderMinutes([60, 10, 10, 0])).toEqual([0, 10, 60]);
    expect(() => normalizeReminderMinutes([-5])).toThrow(ReminderRulesError);
    expect(() => normalizeReminderMinutes([40_321])).toThrow(ReminderRulesError);
    expect(() => normalizeReminderMinutes([1, 2, 3, 4, 5, 6])).toThrow(
      "At most 5",
    );
  });
});

describe("resolvePopupMinutes", () => {
  test("an explicit event list wins, even when empty or email-only", () => {
    expect(
      resolvePopupMinutes({
        eventReminders: [],
        allDay: false,
        preferredMinutes: [30],
      }),
    ).toEqual([]);
    expect(
      resolvePopupMinutes({
        eventReminders: [email(30)],
        allDay: false,
        preferredMinutes: [30],
      }),
    ).toEqual([]);
    expect(
      resolvePopupMinutes({
        eventReminders: [popup(60), popup(5), email(10)],
        allDay: true,
      }),
    ).toEqual([5, 60]);
  });

  test("all-day ignores timed preference and calendar defaults", () => {
    expect(
      resolvePopupMinutes({
        allDay: true,
        preferredMinutes: [30],
        calendarDefaults: [popup(10)],
      }),
    ).toEqual([...DEFAULT_ALL_DAY_REMINDER_MINUTES]);
    expect(
      resolvePopupMinutes({ allDay: true, preferredAllDayMinutes: [360] }),
    ).toEqual([360]);
    expect(resolvePopupMinutes({ allDay: true, preferredAllDayMinutes: [] })).toEqual(
      [],
    );
  });

  test("timed: preference beats calendar default beats [10]", () => {
    expect(
      resolvePopupMinutes({
        allDay: false,
        preferredMinutes: [30],
        calendarDefaults: [popup(10)],
      }),
    ).toEqual([30]);
    expect(
      resolvePopupMinutes({
        allDay: false,
        calendarDefaults: [popup(15), email(60)],
      }),
    ).toEqual([15]);
    expect(resolvePopupMinutes({ allDay: false, calendarDefaults: [] })).toEqual(
      [],
    );
    expect(resolvePopupMinutes({ allDay: false })).toEqual([
      ...DEFAULT_TIMED_REMINDER_MINUTES,
    ]);
  });
});

describe("reminderFireAtMs", () => {
  test("timed reminders are pure epoch arithmetic", () => {
    const startMs = Date.UTC(2026, 8, 10, 14, 0);
    expect(
      reminderFireAtMs({ startMs, allDay: false, minutes: 10, timeZone: "UTC" }),
    ).toBe(startMs - 10 * MS_PER_MINUTE);
  });

  test("all-day reminders count back from local midnight in the zone", () => {
    // Berlin leaves DST on 2026-10-25; the day after is CET (UTC+1).
    const startMs = Date.UTC(2026, 9, 26);
    expect(allDayDateKey(startMs)).toBe("2026-10-26");
    // 09:00 the day before (2026-10-25) is still... midnight 26th is 23:00Z
    // on the 25th; minus 900 min = 08:00Z, which is 09:00 CET.
    expect(
      reminderFireAtMs({
        startMs,
        allDay: true,
        minutes: 900,
        timeZone: "Europe/Berlin",
      }),
    ).toBe(Date.UTC(2026, 9, 25, 8, 0));
    // Auckland (UTC+13 in October, NZDT): midnight 26th = 11:00Z on the 25th.
    expect(
      reminderFireAtMs({
        startMs,
        allDay: true,
        minutes: 0,
        timeZone: "Pacific/Auckland",
      }),
    ).toBe(Date.UTC(2026, 9, 25, 11, 0));
    // Los Angeles (PDT, UTC-7): midnight 26th = 07:00Z on the 26th.
    expect(
      reminderFireAtMs({
        startMs,
        allDay: true,
        minutes: 900,
        timeZone: "America/Los_Angeles",
      }),
    ).toBe(Date.UTC(2026, 9, 25, 16, 0));
  });
});

describe("reminderStillUseful / plannedReminders", () => {
  const timeZone = "UTC";

  test("late reminders fire until the event starts (plus grace)", () => {
    const eventStartMs = Date.UTC(2026, 8, 10, 14, 0);
    const fireAtMs = eventStartMs - 10 * MS_PER_MINUTE;
    const base = { fireAtMs, eventStartMs, allDay: false, timeZone };
    expect(reminderStillUseful({ ...base, nowMs: fireAtMs - 1 })).toBe(true);
    expect(reminderStillUseful({ ...base, nowMs: eventStartMs })).toBe(true);
    expect(
      reminderStillUseful({ ...base, nowMs: eventStartMs + LATE_GRACE_MS - 1 }),
    ).toBe(true);
    expect(
      reminderStillUseful({ ...base, nowMs: eventStartMs + LATE_GRACE_MS }),
    ).toBe(false);
  });

  test("plannedReminders drops beyond-a-week offsets, long-past ones, and dead ones", () => {
    const startMs = Date.UTC(2026, 8, 10, 14, 0);
    const nowMs = startMs - 30 * MS_PER_MINUTE;
    expect(
      plannedReminders({
        startMs,
        allDay: false,
        timeZone,
        minutes: [10, 40, 60, 10_080, 20_160],
        nowMs,
      }),
    ).toEqual([
      { minutes: 10, fireAtMs: startMs - 10 * MS_PER_MINUTE },
      // 10 minutes past its instant: still within the planning grace.
      { minutes: 40, fireAtMs: startMs - 40 * MS_PER_MINUTE },
      // 30 minutes past (60) and a week past (10_080): not planned, so a
      // default change never fires a burst for what is already under way.
    ]);
    expect(
      plannedReminders({
        startMs,
        allDay: false,
        timeZone,
        minutes: [60],
        nowMs: startMs - 60 * MS_PER_MINUTE - PLAN_LATE_GRACE_MS,
      }),
    ).toHaveLength(1);
    // Event already under way past the grace: nothing is planned.
    expect(
      plannedReminders({
        startMs,
        allDay: false,
        timeZone,
        minutes: [10],
        nowMs: startMs + LATE_GRACE_MS,
      }),
    ).toEqual([]);
  });
});
