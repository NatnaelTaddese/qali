// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

import { getNowIndicatorLayout } from "./now-indicator";
import { toRRule, weekdayOf } from "./rrule";
import { pageDays, pageStart, stripDays, zoned } from "./lib";

process.env.SKIP_ENV_VALIDATION = "1";
const { toEventTimes } = await import("./event-form");

// 2026-03-14T02:30Z: 21:30 Sat in New York (EST), 16:30 Sat in Kiritimati of
// the NEXT day (UTC+14 → Sat 16:30? no: +14 → 16:30 on the 14th). Use an
// instant that straddles a date line: 2026-08-26T12:00Z is Wed Aug 26 in both
// hemispheres except UTC+14 where it is 02:00 Thu Aug 27.
const STRADDLE_MS = Date.parse("2026-08-26T12:00:00.000Z");
const NY = "America/New_York";
const KIRITIMATI = "Pacific/Kiritimati"; // UTC+14, no DST

describe("working-zone day cuts", () => {
  test("the same instant lands on different calendar days per zone", () => {
    expect(format(zoned(STRADDLE_MS, NY), "yyyy-MM-dd")).toBe("2026-08-26");
    expect(format(zoned(STRADDLE_MS, KIRITIMATI), "yyyy-MM-dd")).toBe(
      "2026-08-27",
    );
  });

  test("pageStart cuts the week at the working zone's midnight", () => {
    const weekNy = pageStart("week", zoned(STRADDLE_MS, NY), 1);
    const weekKi = pageStart("week", zoned(STRADDLE_MS, KIRITIMATI), 1);
    // Both are Mondays at 00:00 in their own zone…
    expect(format(weekNy, "EEE HH:mm")).toBe("Mon 00:00");
    expect(format(weekKi, "EEE HH:mm")).toBe("Mon 00:00");
    // …but different instants (Kiritimati's Monday midnight comes 18h earlier
    // than New York's on this date: UTC+14 vs UTC-4).
    expect(weekNy.getTime() - weekKi.getTime()).toBe(18 * 60 * 60 * 1000);
  });

  test("stripDays yields consecutive working-zone midnights", () => {
    const anchor = pageStart("day", zoned(STRADDLE_MS, NY), 1);
    const days = stripDays(anchor, 3, 1);
    for (const day of days) {
      expect(format(day, "HH:mm")).toBe("00:00");
      expect((day as TZDate).timeZone).toBe(NY);
    }
  });

  test("month pages carry the zone through the 6x7 grid", () => {
    const start = pageStart("month", zoned(STRADDLE_MS, KIRITIMATI), 1);
    const days = pageDays("month", start, 1);
    expect(days).toHaveLength(42);
    expect(format(days[0], "HH:mm")).toBe("00:00");
    expect((days[41] as TZDate).timeZone).toBe(KIRITIMATI);
  });
});

describe("working-zone now indicator", () => {
  test("finds today's column among zone-cut days and positions by zone clock", () => {
    const anchor = pageStart("day", zoned(STRADDLE_MS, KIRITIMATI), 1);
    const days = stripDays(anchor, 3, 0);
    const layout = getNowIndicatorLayout(days, STRADDLE_MS, KIRITIMATI);
    expect(layout?.today).not.toBeNull();
    // 02:00 in Kiritimati → 2/24 of the way down the day.
    expect(layout?.topPct).toBeCloseTo((2 / 24) * 100, 5);
    // The same instant read in New York sits at 08:00 (EDT, UTC-4).
    const layoutNy = getNowIndicatorLayout(days, STRADDLE_MS, NY);
    expect(layoutNy?.topPct).toBeCloseTo((8 / 24) * 100, 5);
  });
});

describe("working-zone event composition", () => {
  test("all-day boundaries follow the working zone's calendar date", () => {
    const value = {
      startMs: STRADDLE_MS,
      endMs: STRADDLE_MS,
      allDay: true,
    } as Parameters<typeof toEventTimes>[0];
    // Aug 26 in New York…
    expect(toEventTimes(value, NY).startMs).toBe(
      Date.parse("2026-08-26T00:00:00.000Z"),
    );
    // …but Aug 27 across the date line.
    expect(toEventTimes(value, KIRITIMATI).startMs).toBe(
      Date.parse("2026-08-27T00:00:00.000Z"),
    );
  });

  test("recurrence weekday and UNTIL stamp read the working zone", () => {
    // Thursday in Kiritimati, Wednesday in New York.
    expect(weekdayOf(STRADDLE_MS, KIRITIMATI)).toBe("TH");
    expect(weekdayOf(STRADDLE_MS, NY)).toBe("WE");

    const rule = (tz: string) =>
      toRRule(
        {
          freq: "DAILY",
          interval: 1,
          end: { kind: "onDate", dateMs: STRADDLE_MS },
        },
        tz,
      )[0];
    expect(rule(NY)).toContain("UNTIL=20260826T235959Z");
    expect(rule(KIRITIMATI)).toContain("UNTIL=20260827T235959Z");
  });
});
