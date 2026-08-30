// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { STRIP_SIDE_DAYS, stripDays, VIEW_COLUMNS } from "./lib";
import { getNowIndicatorLayout } from "./now-indicator";

// Mirror production geometry rather than hardcoding it, so widening the buffer
// doesn't silently leave these tests exercising a strip the app never renders.
const WEEK_SIDE = STRIP_SIDE_DAYS.week;
const DAY_SIDE = STRIP_SIDE_DAYS.day;

// These cases build their strips from runner-local Dates, so the runner's own
// zone is the working zone; working-zone.test.ts covers explicit zones.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe("getNowIndicatorLayout", () => {
  test("positions today's column within the full buffered strip", () => {
    const weekStart = new Date(2026, 6, 13);
    const days = stripDays(weekStart, VIEW_COLUMNS.week, WEEK_SIDE);
    const now = new Date(2026, 6, 19, 9, 30).getTime();

    const layout = getNowIndicatorLayout(days, now, TZ);

    expect(layout).not.toBeNull();
    // July 19 is 6 days after the anchor, which itself sits at WEEK_SIDE.
    const todayIdx = WEEK_SIDE + 6;
    expect(layout?.today?.leftPct).toBeCloseTo((todayIdx / days.length) * 100);
    expect(layout?.today?.widthPct).toBeCloseTo((1 / days.length) * 100);
    expect(layout?.topPct).toBeCloseTo((9.5 / 24) * 100);
  });

  test("positions today's column within a buffered day strip", () => {
    const today = new Date(2026, 6, 19);
    const days = stripDays(today, VIEW_COLUMNS.day, DAY_SIDE);
    const now = new Date(2026, 6, 19, 15).getTime();

    const layout = getNowIndicatorLayout(days, now, TZ);

    expect(layout).not.toBeNull();
    expect(layout?.today?.leftPct).toBeCloseTo((DAY_SIDE / days.length) * 100);
    expect(layout?.today?.widthPct).toBeCloseTo((1 / days.length) * 100);
    expect(layout?.topPct).toBeCloseTo((15 / 24) * 100);
  });

  test("still shows the line when today is off the visible window", () => {
    const visibleStart = new Date(2026, 6, 20);
    const days = stripDays(visibleStart, VIEW_COLUMNS.week, WEEK_SIDE);
    const now = new Date(2026, 6, 19, 12).getTime();

    const layout = getNowIndicatorLayout(days, now, TZ);

    // The current-time line always renders; today's column is still marked so
    // long as the day sits somewhere in the buffered strip.
    expect(layout).not.toBeNull();
    expect(layout?.topPct).toBeCloseTo((12 / 24) * 100);
    expect(layout?.today).not.toBeNull();
  });

  test("today's column shifts when the local date rolls over at midnight", () => {
    const weekStart = new Date(2026, 6, 13);
    const days = stripDays(weekStart, VIEW_COLUMNS.week, WEEK_SIDE);
    const beforeMidnight = new Date(2026, 6, 19, 23, 59).getTime();
    const afterMidnight = new Date(2026, 6, 20, 0, 0).getTime();

    const before = getNowIndicatorLayout(days, beforeMidnight, TZ);
    const after = getNowIndicatorLayout(days, afterMidnight, TZ);

    // The marked column advances one day across midnight.
    const julyNineteenth = WEEK_SIDE + 6;
    expect(before?.today?.leftPct).toBeCloseTo(
      (julyNineteenth / days.length) * 100,
    );
    expect(after?.today?.leftPct).toBeCloseTo(
      ((julyNineteenth + 1) / days.length) * 100,
    );
  });
});
