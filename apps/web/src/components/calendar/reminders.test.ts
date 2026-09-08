// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
  ALL_DAY_PRESETS,
  allDayMinutes,
  labelFor,
  normalizeReminders,
  sameReminders,
  splitAllDay,
  summarizeReminders,
  togglePopup,
  type Reminder,
} from "./reminders";

const popup = (minutes: number): Reminder => ({ method: "popup", minutes });
const email = (minutes: number): Reminder => ({ method: "email", minutes });

describe("labelFor", () => {
  test("timed offsets read in the largest whole unit", () => {
    expect(labelFor(0, false, true)).toBe("At time of event");
    expect(labelFor(5, false, true)).toBe("5 min before");
    expect(labelFor(60, false, true)).toBe("1 hour before");
    expect(labelFor(90, false, true)).toBe("90 min before");
    expect(labelFor(120, false, true)).toBe("2 hours before");
    expect(labelFor(1440, false, true)).toBe("1 day before");
    expect(labelFor(2880, false, true)).toBe("2 days before");
    expect(labelFor(10_080, false, true)).toBe("1 week before");
  });

  test("all-day offsets read as a day and a wall-clock time", () => {
    expect(labelFor(900, true, true)).toBe("The day before at 09:00");
    expect(labelFor(900, true, false)).toBe("The day before at 9:00 AM");
    expect(labelFor(360, true, false)).toBe("The day before at 6:00 PM");
    expect(labelFor(2340, true, true)).toBe("2 days before at 09:00");
    expect(labelFor(9540, true, true)).toBe("A week before at 09:00");
    expect(labelFor(0, true, false)).toBe("On the day at 12:00 AM");
  });
});

describe("all-day arithmetic", () => {
  test("round-trips days and time of day", () => {
    expect(allDayMinutes(1, 9 * 60)).toBe(900);
    expect(splitAllDay(900)).toEqual({ days: 1, timeOfDay: 540 });
    expect(splitAllDay(0)).toEqual({ days: 0, timeOfDay: 0 });
    expect(splitAllDay(1440)).toEqual({ days: 1, timeOfDay: 0 });
    for (const preset of ALL_DAY_PRESETS) {
      const { days, timeOfDay } = splitAllDay(preset);
      expect(allDayMinutes(days, timeOfDay)).toBe(preset);
    }
  });

  test("clamps to the provider range", () => {
    expect(allDayMinutes(0, 540)).toBe(0);
    expect(allDayMinutes(40, 0)).toBe(40_320);
  });
});

describe("summarizeReminders", () => {
  test("default, none, one, many", () => {
    expect(summarizeReminders(null, false, true)).toBe("Default");
    expect(summarizeReminders(null, false, true, [10])).toBe("Default · 10 min before");
    expect(summarizeReminders(null, false, true, [10, 60])).toBe(
      "Default · 10 min before +1",
    );
    expect(summarizeReminders(null, true, true, [])).toBe("Default");
    expect(summarizeReminders([], false, true)).toBe("None");
    expect(summarizeReminders([email(30)], false, true)).toBe("None");
    expect(summarizeReminders([popup(10)], false, true)).toBe("10 min before");
    expect(summarizeReminders([popup(10), popup(60), email(5)], false, true)).toBe(
      "2 reminders",
    );
  });
});

describe("normalizeReminders / sameReminders / togglePopup", () => {
  test("dedupes, sorts, drops out-of-range, caps at five", () => {
    expect(normalizeReminders([popup(60), popup(10), popup(10), popup(-1), popup(99_999)])).toEqual(
      [popup(10), popup(60)],
    );
    expect(normalizeReminders([0, 5, 10, 15, 30, 60].map(popup))).toHaveLength(5);
  });

  test("sameReminders is order-insensitive and null-aware", () => {
    expect(sameReminders([popup(10), email(30)], [email(30), popup(10)])).toBe(true);
    expect(sameReminders(null, null)).toBe(true);
    expect(sameReminders(null, [])).toBe(false);
    expect(sameReminders([popup(10)], [popup(15)])).toBe(false);
  });

  test("togglePopup adds, removes, and leaves email entries alone", () => {
    expect(togglePopup([email(30)], 10)).toEqual([popup(10), email(30)]);
    expect(togglePopup([popup(10), email(30)], 10)).toEqual([email(30)]);
  });
});
