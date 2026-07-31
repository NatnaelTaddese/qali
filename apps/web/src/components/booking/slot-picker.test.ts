// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import type { SlotOption } from "@qali/backend/convex/lib/availability";

import { groupByTimeOfDay, timeOfDay } from "./slot-picker";

/** A slot at local `hour:minute` on an arbitrary fixed day. Local, to match how
 * the picker reads and renders times. */
function slotAt(hour: number, minute = 0, available = true): SlotOption {
  return { startMs: new Date(2026, 6, 15, hour, minute).getTime(), available };
}

describe("timeOfDay", () => {
  test("splits on noon and 5pm boundaries", () => {
    expect(timeOfDay(slotAt(0).startMs)).toBe("morning");
    expect(timeOfDay(slotAt(11, 59).startMs)).toBe("morning");
    expect(timeOfDay(slotAt(12).startMs)).toBe("afternoon");
    expect(timeOfDay(slotAt(16, 59).startMs)).toBe("afternoon");
    expect(timeOfDay(slotAt(17).startMs)).toBe("evening");
    expect(timeOfDay(slotAt(23, 30).startMs)).toBe("evening");
  });
});

describe("groupByTimeOfDay", () => {
  test("orders sections morning→afternoon→evening and keeps slot order", () => {
    const slots = [slotAt(9), slotAt(10), slotAt(13), slotAt(18)];
    const sections = groupByTimeOfDay(slots);
    expect(sections.map((s) => s.key)).toEqual([
      "morning",
      "afternoon",
      "evening",
    ]);
    expect(sections[0].slots).toEqual([slots[0], slots[1]]);
    expect(sections[1].slots).toEqual([slots[2]]);
    expect(sections[2].slots).toEqual([slots[3]]);
  });

  test("drops empty sections", () => {
    const sections = groupByTimeOfDay([slotAt(9), slotAt(10, 30)]);
    expect(sections.map((s) => s.key)).toEqual(["morning"]);
  });

  test("keeps taken slots in their section", () => {
    const sections = groupByTimeOfDay([slotAt(9, 0, false), slotAt(9, 30, true)]);
    expect(sections).toHaveLength(1);
    expect(sections[0].slots.map((s) => s.available)).toEqual([false, true]);
  });
});
