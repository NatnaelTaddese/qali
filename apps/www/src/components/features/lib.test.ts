// @ts-expect-error Bun supplies its test module at runtime; the marketing app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { autoStateAt } from "./assistant-scene";
import {
  BASE_EVENTS,
  deriveGrid,
  formatRange,
  heightPct,
  hoursIn,
  topPct,
} from "./lib";

describe("grid geometry", () => {
  test("positions minutes within the default 8am–6pm window", () => {
    expect(topPct(8 * 60)).toBe(0);
    expect(topPct(13 * 60)).toBe(50);
    expect(heightPct(9 * 60, 10 * 60)).toBe(10);
  });

  test("honours a custom window", () => {
    const win = { start: 9 * 60, end: 17 * 60 };
    expect(topPct(13 * 60, win)).toBe(50);
    expect(heightPct(9 * 60, 12 * 60, win)).toBe(37.5);
    expect(hoursIn(win)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  test("formats a range in 12-hour time", () => {
    expect(formatRange(8 * 60, 10 * 60 + 30)).toBe("8:00 AM – 10:30 AM");
    expect(formatRange(12 * 60, 13 * 60)).toBe("12:00 PM – 1:00 PM");
  });
});

describe("deriveGrid", () => {
  test("starts from the base week untouched", () => {
    const grid = deriveGrid(new Set());
    expect(grid.events).toBe(BASE_EVENTS);
    expect(grid.ghost).toBeNull();
    expect(grid.removed.size).toBe(0);
  });

  test("move puts the Focus block at 8am", () => {
    const grid = deriveGrid(new Set(["move"] as const));
    const focus = grid.events.find((e) => e.id === "wed-focus");
    expect(focus?.start).toBe(8 * 60);
    expect(focus?.end).toBe(10 * 60);
  });

  test("find surfaces a Thursday slot and clear removes Priya", () => {
    const grid = deriveGrid(new Set(["find", "clear"] as const));
    expect(grid.ghost).toEqual({
      day: 3,
      start: 10 * 60,
      end: 10 * 60 + 30,
      label: "Suggested",
    });
    expect(grid.removed.has("fri-priya")).toBe(true);
  });
});

describe("assistant auto loop", () => {
  test("rests on a clean grid, then applies each scene in order", () => {
    expect(autoStateAt(0).applied.size).toBe(0);
    expect(autoStateAt(0).busy).toBeNull();

    const thinking = autoStateAt(1);
    expect(thinking.busy?.id).toBe("move");
    expect(thinking.applied.size).toBe(0);

    const moved = autoStateAt(2);
    expect(moved.busy).toBeNull();
    expect([...moved.applied]).toEqual(["move"]);
    expect(moved.confirmation).toBe("Moved Focus block to 8:00 AM");

    const all = autoStateAt(6);
    expect([...all.applied]).toEqual(["move", "find", "clear"]);
    expect(all.confirmation).toBe("Cleared Friday afternoon");
  });
});
