// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { stripDays } from "./lib";
import { getNowIndicatorLayout } from "./now-indicator";

describe("getNowIndicatorLayout", () => {
  test("positions today's column within the full buffered strip", () => {
    const weekStart = new Date(2026, 6, 13);
    const days = stripDays(weekStart, 7, 12);
    const now = new Date(2026, 6, 19, 9, 30).getTime();

    const layout = getNowIndicatorLayout(days, now);

    expect(layout).not.toBeNull();
    // July 19 is index 18 in a strip that starts 12 days before July 13.
    expect(layout?.today?.leftPct).toBeCloseTo((18 / days.length) * 100);
    expect(layout?.today?.widthPct).toBeCloseTo((1 / days.length) * 100);
    expect(layout?.topPct).toBeCloseTo((9.5 / 24) * 100);
  });

  test("positions today's column within a buffered day strip", () => {
    const today = new Date(2026, 6, 19);
    const days = stripDays(today, 1, 6);
    const now = new Date(2026, 6, 19, 15).getTime();

    const layout = getNowIndicatorLayout(days, now);

    expect(layout).not.toBeNull();
    expect(layout?.today?.leftPct).toBeCloseTo((6 / days.length) * 100);
    expect(layout?.today?.widthPct).toBeCloseTo((1 / days.length) * 100);
    expect(layout?.topPct).toBeCloseTo((15 / 24) * 100);
  });

  test("still shows the line when today is off the visible window", () => {
    const visibleStart = new Date(2026, 6, 20);
    const days = stripDays(visibleStart, 7, 12);
    const now = new Date(2026, 6, 19, 12).getTime();

    const layout = getNowIndicatorLayout(days, now);

    // The current-time line always renders; today's column is still marked so
    // long as the day sits somewhere in the buffered strip.
    expect(layout).not.toBeNull();
    expect(layout?.topPct).toBeCloseTo((12 / 24) * 100);
    expect(layout?.today).not.toBeNull();
  });

  test("today's column shifts when the local date rolls over at midnight", () => {
    const weekStart = new Date(2026, 6, 13);
    const days = stripDays(weekStart, 7, 12);
    const beforeMidnight = new Date(2026, 6, 19, 23, 59).getTime();
    const afterMidnight = new Date(2026, 6, 20, 0, 0).getTime();

    const before = getNowIndicatorLayout(days, beforeMidnight);
    const after = getNowIndicatorLayout(days, afterMidnight);

    // July 19 → index 18, July 20 → index 19: the marked column advances a day.
    expect(before?.today?.leftPct).toBeCloseTo((18 / days.length) * 100);
    expect(after?.today?.leftPct).toBeCloseTo((19 / days.length) * 100);
  });
});
