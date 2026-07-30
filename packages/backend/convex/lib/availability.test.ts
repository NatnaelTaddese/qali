// @ts-expect-error Bun supplies its test module at runtime; the Convex
// TypeScript project intentionally does not include Bun's ambient types.
import { describe, expect, test } from "bun:test";

import {
  addDaysToDateKey,
  allDayBusyInterval,
  generateSlots,
  mergeIntervals,
  MS_PER_MINUTE,
  subtractIntervals,
  utcToZoned,
  weekdayOfDateKey,
  zonedToUtcMs,
  zoneOffsetMs,
  type SlotConfig,
} from "./availability";

const NY = "America/New_York";
const UTC = "UTC";
const KATHMANDU = "Asia/Kathmandu"; // +05:45, no DST — catches offset math that assumes whole hours
const SYDNEY = "Australia/Sydney"; // southern hemisphere DST

const HOUR = 60 * MS_PER_MINUTE;

/** Weekdays Mon–Fri, 09:00–17:00. */
const NINE_TO_FIVE = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMin: 9 * 60,
  endMin: 17 * 60,
}));

/** A config with everything permissive, so each test can vary one thing. */
function config(overrides: Partial<SlotConfig> = {}): SlotConfig {
  const nowMs = zonedToUtcMs("2026-08-03", 0, NY); // Monday, local midnight
  return {
    timeZone: NY,
    rules: NINE_TO_FIVE,
    overrides: [],
    busy: [],
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeMinutes: 0,
    horizonDays: 60,
    fromMs: nowMs,
    toMs: nowMs + 24 * HOUR,
    nowMs,
    ...overrides,
  };
}

/** Slot starts as "HH:MM" in the host's zone, for readable assertions. */
function asLocalTimes(slots: number[], timeZone = NY): string[] {
  return slots.map((ms) => {
    const { minutes } = utcToZoned(ms, timeZone);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  });
}

describe("zoneOffsetMs", () => {
  test("is zero in UTC", () => {
    expect(zoneOffsetMs(Date.UTC(2026, 6, 1), UTC)).toBe(0);
  });

  test("tracks New York across its DST boundary", () => {
    expect(zoneOffsetMs(Date.UTC(2026, 0, 15, 12), NY)).toBe(-5 * HOUR);
    expect(zoneOffsetMs(Date.UTC(2026, 6, 15, 12), NY)).toBe(-4 * HOUR);
  });

  test("handles a fractional-hour zone", () => {
    expect(zoneOffsetMs(Date.UTC(2026, 6, 15, 12), KATHMANDU)).toBe(
      5 * HOUR + 45 * MS_PER_MINUTE,
    );
  });
});

describe("zonedToUtcMs", () => {
  test("round-trips a wall clock through the zone", () => {
    const ms = zonedToUtcMs("2026-08-03", 9 * 60, NY);
    expect(new Date(ms).toISOString()).toBe("2026-08-03T13:00:00.000Z"); // EDT, -4
    expect(utcToZoned(ms, NY)).toEqual({
      dateKey: "2026-08-03",
      weekday: 1,
      minutes: 9 * 60,
    });
  });

  test("uses the offset in force on the day, not today's", () => {
    // Same 9am rule, six months apart: EST then EDT.
    expect(new Date(zonedToUtcMs("2026-01-05", 9 * 60, NY)).toISOString()).toBe(
      "2026-01-05T14:00:00.000Z",
    );
    expect(new Date(zonedToUtcMs("2026-07-06", 9 * 60, NY)).toISOString()).toBe(
      "2026-07-06T13:00:00.000Z",
    );
  });

  test("treats minutes past 1440 as the following midnight", () => {
    expect(zonedToUtcMs("2026-08-03", 24 * 60, NY)).toBe(
      zonedToUtcMs("2026-08-04", 0, NY),
    );
  });

  test("a spring-forward day is 23 hours long", () => {
    // 2026-03-08 is the US DST start: 02:00 local never happens.
    const start = zonedToUtcMs("2026-03-08", 0, NY);
    const end = zonedToUtcMs("2026-03-09", 0, NY);
    expect(end - start).toBe(23 * HOUR);
  });

  test("a fall-back day is 25 hours long", () => {
    const start = zonedToUtcMs("2026-11-01", 0, NY);
    const end = zonedToUtcMs("2026-11-02", 0, NY);
    expect(end - start).toBe(25 * HOUR);
  });
});

describe("weekdayOfDateKey", () => {
  test("reads Sunday as 0", () => {
    expect(weekdayOfDateKey("2026-08-02")).toBe(0);
    expect(weekdayOfDateKey("2026-08-03")).toBe(1);
    expect(weekdayOfDateKey("2026-08-08")).toBe(6);
  });
});

describe("addDaysToDateKey", () => {
  test("crosses month and year boundaries", () => {
    expect(addDaysToDateKey("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysToDateKey("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDaysToDateKey("2028-02-28", 1)).toBe("2028-02-29"); // leap year
  });
});

describe("mergeIntervals", () => {
  test("coalesces overlapping and touching spans and drops empty ones", () => {
    expect(
      mergeIntervals([
        { startMs: 30, endMs: 40 },
        { startMs: 0, endMs: 10 },
        { startMs: 5, endMs: 8 },
        { startMs: 10, endMs: 20 },
        { startMs: 50, endMs: 50 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 20 },
      { startMs: 30, endMs: 40 },
    ]);
  });
});

describe("subtractIntervals", () => {
  test("punches a hole in the middle", () => {
    expect(
      subtractIntervals([{ startMs: 0, endMs: 100 }], [{ startMs: 40, endMs: 60 }]),
    ).toEqual([
      { startMs: 0, endMs: 40 },
      { startMs: 60, endMs: 100 },
    ]);
  });

  test("a cut covering the base leaves nothing", () => {
    expect(
      subtractIntervals([{ startMs: 10, endMs: 20 }], [{ startMs: 0, endMs: 30 }]),
    ).toEqual([]);
  });

  test("cuts outside the base are ignored", () => {
    expect(
      subtractIntervals(
        [{ startMs: 10, endMs: 20 }],
        [
          { startMs: 0, endMs: 10 },
          { startMs: 20, endMs: 30 },
        ],
      ),
    ).toEqual([{ startMs: 10, endMs: 20 }]);
  });

  test("multiple cuts across multiple bases", () => {
    expect(
      subtractIntervals(
        [
          { startMs: 0, endMs: 50 },
          { startMs: 100, endMs: 150 },
        ],
        [
          { startMs: 20, endMs: 30 },
          { startMs: 45, endMs: 110 },
        ],
      ),
    ).toEqual([
      { startMs: 0, endMs: 20 },
      { startMs: 30, endMs: 45 },
      { startMs: 110, endMs: 150 },
    ]);
  });
});

describe("allDayBusyInterval", () => {
  test("re-anchors UTC-midnight bounds to local midnight", () => {
    // Google's shape for all of 2026-08-03, exclusive end.
    const interval = allDayBusyInterval(
      Date.UTC(2026, 7, 3),
      Date.UTC(2026, 7, 4),
      NY,
    );
    expect(new Date(interval.startMs).toISOString()).toBe(
      "2026-08-03T04:00:00.000Z",
    );
    expect(new Date(interval.endMs).toISOString()).toBe(
      "2026-08-04T04:00:00.000Z",
    );
  });
});

describe("generateSlots", () => {
  test("steps a weekday window at the slot size", () => {
    const slots = generateSlots(config({ slotMinutes: 60 }));
    expect(asLocalTimes(slots)).toEqual([
      "09:00",
      "10:00",
      "11:00",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
    ]);
  });

  test("offers nothing on a weekday with no rule", () => {
    const sunday = zonedToUtcMs("2026-08-02", 0, NY);
    expect(
      generateSlots(
        config({ fromMs: sunday, toMs: sunday + 24 * HOUR, nowMs: sunday }),
      ),
    ).toEqual([]);
  });

  test("cuts a busy event out of the middle", () => {
    const slots = generateSlots(
      config({
        slotMinutes: 60,
        busy: [
          {
            startMs: zonedToUtcMs("2026-08-03", 11 * 60, NY),
            endMs: zonedToUtcMs("2026-08-03", 13 * 60, NY),
          },
        ],
      }),
    );
    expect(asLocalTimes(slots)).toEqual([
      "09:00",
      "10:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
    ]);
  });

  test("a buffer widens a busy event on both sides", () => {
    const slots = generateSlots(
      config({
        slotMinutes: 60,
        bufferMinutes: 30,
        busy: [
          {
            startMs: zonedToUtcMs("2026-08-03", 11 * 60, NY),
            endMs: zonedToUtcMs("2026-08-03", 12 * 60, NY),
          },
        ],
      }),
    );
    // 10:00 would end at 11:00, inside the leading buffer; the window reopens
    // at 12:30, so the next hour slot starts there rather than on the hour.
    expect(asLocalTimes(slots)).toEqual([
      "09:00",
      "12:30",
      "13:30",
      "14:30",
      "15:30",
    ]);
  });

  test("an all-day busy event blocks the whole day", () => {
    const slots = generateSlots(
      config({
        busy: [
          allDayBusyInterval(Date.UTC(2026, 7, 3), Date.UTC(2026, 7, 4), NY),
        ],
      }),
    );
    expect(slots).toEqual([]);
  });

  test("minimum notice drops the slots that are too soon", () => {
    const nowMs = zonedToUtcMs("2026-08-03", 9 * 60, NY); // 9am, mid-window
    const slots = generateSlots(
      config({
        slotMinutes: 60,
        minNoticeMinutes: 120,
        nowMs,
        fromMs: zonedToUtcMs("2026-08-03", 0, NY),
        toMs: zonedToUtcMs("2026-08-04", 0, NY),
      }),
    );
    expect(asLocalTimes(slots)).toEqual(["11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]);
  });

  test("the horizon caps how far ahead slots run", () => {
    const nowMs = zonedToUtcMs("2026-08-03", 0, NY);
    const slots = generateSlots(
      config({
        horizonDays: 1,
        nowMs,
        fromMs: nowMs,
        toMs: nowMs + 7 * 24 * HOUR,
      }),
    );
    // Only Monday's window falls inside a one-day horizon.
    expect(slots.length).toBe(16);
    expect(slots.every((ms) => ms < nowMs + 24 * HOUR)).toBe(true);
  });

  test("an override with no intervals blocks the day outright", () => {
    expect(
      generateSlots(
        config({ overrides: [{ dateKey: "2026-08-03", intervals: [] }] }),
      ),
    ).toEqual([]);
  });

  test("an override replaces the weekday's rules rather than adding to them", () => {
    const slots = generateSlots(
      config({
        slotMinutes: 60,
        overrides: [
          {
            dateKey: "2026-08-03",
            intervals: [{ startMin: 20 * 60, endMin: 22 * 60 }],
          },
        ],
      }),
    );
    expect(asLocalTimes(slots)).toEqual(["20:00", "21:00"]);
  });

  test("an override opens a day the weekly rules leave closed", () => {
    const sunday = zonedToUtcMs("2026-08-02", 0, NY);
    const slots = generateSlots(
      config({
        slotMinutes: 60,
        fromMs: sunday,
        toMs: sunday + 24 * HOUR,
        nowMs: sunday,
        overrides: [
          {
            dateKey: "2026-08-02",
            intervals: [{ startMin: 10 * 60, endMin: 12 * 60 }],
          },
        ],
      }),
    );
    expect(asLocalTimes(slots)).toEqual(["10:00", "11:00"]);
  });

  test("a pending booking holds its slot", () => {
    const slots = generateSlots(
      config({
        slotMinutes: 60,
        busy: [
          {
            startMs: zonedToUtcMs("2026-08-03", 10 * 60, NY),
            endMs: zonedToUtcMs("2026-08-03", 11 * 60, NY),
          },
        ],
      }),
    );
    expect(asLocalTimes(slots)).not.toContain("10:00");
    expect(asLocalTimes(slots)).toContain("11:00");
  });

  test("slots stay on the host's wall clock across a spring-forward day", () => {
    // 2026-03-08 (Sunday) is the DST jump; Monday 2026-03-09 must still be 9am
    // local, which is a different UTC hour than the Friday before.
    const friday = zonedToUtcMs("2026-03-06", 0, NY);
    const monday = zonedToUtcMs("2026-03-09", 0, NY);
    const before = generateSlots(
      config({
        slotMinutes: 60,
        fromMs: friday,
        toMs: friday + 24 * HOUR,
        nowMs: friday,
      }),
    );
    const after = generateSlots(
      config({
        slotMinutes: 60,
        fromMs: monday,
        toMs: monday + 24 * HOUR,
        nowMs: monday,
      }),
    );
    expect(asLocalTimes(before)[0]).toBe("09:00");
    expect(asLocalTimes(after)[0]).toBe("09:00");
    expect(new Date(before[0]).toISOString()).toBe("2026-03-06T14:00:00.000Z");
    expect(new Date(after[0]).toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  test("a window straddling the zone's date boundary is still found", () => {
    // Sydney is +10/+11, so a Monday-morning local window sits in Sunday UTC.
    const rules = [{ weekday: 1, startMin: 9 * 60, endMin: 11 * 60 }];
    const mondayLocal = zonedToUtcMs("2026-08-03", 0, SYDNEY);
    const slots = generateSlots({
      ...config(),
      timeZone: SYDNEY,
      rules,
      slotMinutes: 60,
      fromMs: mondayLocal,
      toMs: mondayLocal + 24 * HOUR,
      nowMs: mondayLocal,
    });
    expect(asLocalTimes(slots, SYDNEY)).toEqual(["09:00", "10:00"]);
    expect(new Date(slots[0]).toISOString()).toBe("2026-08-02T23:00:00.000Z");
  });

  test("a request window narrower than the day clips the slots", () => {
    const slots = generateSlots(
      config({
        slotMinutes: 60,
        fromMs: zonedToUtcMs("2026-08-03", 10 * 60, NY),
        toMs: zonedToUtcMs("2026-08-03", 13 * 60, NY),
      }),
    );
    expect(asLocalTimes(slots)).toEqual(["10:00", "11:00", "12:00"]);
  });

  test("a zero-length or inverted rule is ignored", () => {
    expect(
      generateSlots(
        config({ rules: [{ weekday: 1, startMin: 17 * 60, endMin: 9 * 60 }] }),
      ),
    ).toEqual([]);
  });
});
