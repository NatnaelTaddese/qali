// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
  calendarDisplayName,
  type CalendarEvent,
  formatWallClockMinutes,
  laneBox,
  layoutAllDayEvents,
  layoutDayEvents,
  visibleAllDayMetrics,
  visibleMonthEventMetrics,
} from "./lib";

const days = Array.from({ length: 5 }, (_, i) => new Date(2026, 0, 5 + i));

const dayStart = new Date(2026, 0, 5).getTime();
/** A timed event on the test day, from `startH:startM` to `endH:endM` (24h). */
function timedEvent(
  id: string,
  startH: number,
  startM: number,
  endH: number,
  endM: number,
): CalendarEvent {
  const at = (h: number, m: number) => dayStart + (h * 60 + m) * 60_000;
  return {
    _id: id,
    startMs: at(startH, startM),
    endMs: at(endH, endM),
  } as unknown as CalendarEvent;
}

function allDayEvent(
  id: string,
  startDay: number,
  endDayExclusive: number,
): CalendarEvent {
  return {
    _id: id,
    startMs: Date.UTC(2026, 0, 5 + startDay),
    endMs: Date.UTC(2026, 0, 5 + endDayExclusive),
    allDay: true,
  } as unknown as CalendarEvent;
}

describe("calendarDisplayName", () => {
  test("prefers the user's override, then summary, then calendar id", () => {
    expect(
      calendarDisplayName({
        googleCalendarId: "primary@example.com",
        summary: "Primary",
        summaryOverride: "My calendar",
      }),
    ).toBe("My calendar");
    expect(
      calendarDisplayName({
        googleCalendarId: "team@example.com",
        summary: "Team",
      }),
    ).toBe("Team");
    expect(
      calendarDisplayName({ googleCalendarId: "fallback@example.com" }),
    ).toBe("fallback@example.com");
  });
});

describe("formatWallClockMinutes", () => {
  test("formats wall-clock bounds without a date or timezone", () => {
    expect(formatWallClockMinutes(0)).toBe("12:00 AM");
    expect(formatWallClockMinutes(9 * 60 + 15, false)).toBe("9:15");
    expect(formatWallClockMinutes(13 * 60 + 5)).toBe("1:05 PM");
    expect(formatWallClockMinutes(24 * 60)).toBe("12:00 AM");
  });
});

describe("visibleMonthEventMetrics", () => {
  test("uses all available rows when every event fits", () => {
    expect(visibleMonthEventMetrics(5, 98)).toEqual({
      visibleCount: 5,
      hiddenCount: 0,
    });
  });

  test("reserves the final available row for the overflow count", () => {
    expect(visibleMonthEventMetrics(6, 98)).toEqual({
      visibleCount: 4,
      hiddenCount: 2,
    });
  });

  test("shows only the overflow count when one row is available", () => {
    expect(visibleMonthEventMetrics(3, 18)).toEqual({
      visibleCount: 0,
      hiddenCount: 3,
    });
  });

  test("never returns a negative visible count for a constrained cell", () => {
    expect(visibleMonthEventMetrics(3, 0)).toEqual({
      visibleCount: 0,
      hiddenCount: 3,
    });
  });
});

describe("layoutAllDayEvents", () => {
  test("reuses a lane when event spans do not overlap", () => {
    const layout = layoutAllDayEvents(days, [
      allDayEvent("monday", 0, 1),
      allDayEvent("tuesday", 1, 2),
    ]);

    expect(layout.map((event) => event.lane)).toEqual([0, 0]);
  });

  test("assigns concurrent events to separate lanes", () => {
    const layout = layoutAllDayEvents(days, [
      allDayEvent("first", 0, 1),
      allDayEvent("second", 0, 1),
      allDayEvent("third", 0, 1),
    ]);

    expect(layout.map((event) => event.lane)).toEqual([0, 1, 2]);
    expect(visibleAllDayMetrics(layout, 0, 0)).toEqual({
      laneCount: 3,
      hiddenEventCount: 1,
    });
  });

  test("reserves a lane across a multi-day event span", () => {
    const layout = layoutAllDayEvents(days, [
      allDayEvent("spanning", 0, 3),
      allDayEvent("tuesday", 1, 2),
      allDayEvent("wednesday", 2, 3),
    ]);

    expect(
      Object.fromEntries(layout.map(({ event, lane }) => [event._id, lane])),
    ).toEqual({ spanning: 0, tuesday: 1, wednesday: 1 });
  });

  test("counts overflow only within the visible day range", () => {
    const layout = layoutAllDayEvents(days, [
      allDayEvent("first", 3, 4),
      allDayEvent("second", 3, 4),
      allDayEvent("third", 3, 4),
    ]);

    expect(visibleAllDayMetrics(layout, 0, 1)).toEqual({
      laneCount: 0,
      hiddenEventCount: 0,
    });
    expect(visibleAllDayMetrics(layout, 3, 3)).toEqual({
      laneCount: 3,
      hiddenEventCount: 1,
    });
  });

  test("repacks continuing events when earlier conflicts leave the visible range", () => {
    const layout = layoutAllDayEvents(
      days,
      [
        allDayEvent("first", 0, 3),
        allDayEvent("second", 0, 3),
        allDayEvent("continuing", 1, 5),
      ],
      3,
      4,
    );

    expect(layout).toHaveLength(1);
    expect(layout[0].lane).toBe(0);
    expect(layout[0].startIdx).toBe(3);
    expect(layout[0].endIdx).toBe(4);
  });
});

describe("layoutDayEvents columns", () => {
  const byId = (layout: ReturnType<typeof layoutDayEvents>) =>
    Object.fromEntries(layout.map((p) => [p.event._id, p]));

  test("sequential events each stand alone in a single column", () => {
    const layout = byId(
      layoutDayEvents(
        [timedEvent("a", 9, 0, 10, 0), timedEvent("b", 10, 0, 11, 0)],
        dayStart,
      ),
    );

    for (const id of ["a", "b"]) {
      expect(layout[id].columnCount).toBe(1);
      expect(layout[id].columnIndex).toBe(0);
      expect(layout[id].columnSpan).toBe(1);
    }
  });

  test("concurrent events split into adjacent columns", () => {
    const layout = byId(
      layoutDayEvents(
        [timedEvent("a", 9, 0, 10, 0), timedEvent("b", 9, 0, 10, 0)],
        dayStart,
      ),
    );

    expect(layout.a.columnCount).toBe(2);
    expect(layout.b.columnCount).toBe(2);
    expect([layout.a.columnIndex, layout.b.columnIndex].sort()).toEqual([0, 1]);
    expect(layout.a.columnSpan).toBe(1);
    expect(layout.b.columnSpan).toBe(1);
  });

  test("a transitive overlap chain that is not all-concurrent reuses a lane", () => {
    // a↔b overlap and b↔c overlap, but a and c do not: two columns suffice.
    const layout = byId(
      layoutDayEvents(
        [
          timedEvent("a", 9, 0, 10, 0),
          timedEvent("b", 9, 30, 11, 0),
          timedEvent("c", 10, 30, 12, 0),
        ],
        dayStart,
      ),
    );

    expect(layout.a.columnCount).toBe(2);
    expect(layout.a.columnIndex).toBe(0);
    expect(layout.b.columnIndex).toBe(1);
    expect(layout.c.columnIndex).toBe(0);
  });

  test("a card expands right across lanes left free by non-overlapping neighbours", () => {
    // long anchors a 3-wide cluster (b,c concurrent at 9:00); d at 10:00 sits in
    // b's freed lane and, with nothing overlapping it in lane 2, spans both.
    const layout = byId(
      layoutDayEvents(
        [
          timedEvent("long", 9, 0, 11, 0),
          timedEvent("b", 9, 0, 9, 30),
          timedEvent("c", 9, 0, 9, 30),
          timedEvent("d", 10, 0, 10, 30),
        ],
        dayStart,
      ),
    );

    expect(layout.d.columnCount).toBe(3);
    expect(layout.d.columnIndex).toBe(1);
    expect(layout.d.columnSpan).toBe(2);
  });
});

describe("laneBox", () => {
  test("a lone card fills the whole column", () => {
    expect(laneBox(0, 1, 1)).toEqual({ left: 0, width: 1 });
  });

  test("two lanes overlap rather than splitting into clean halves", () => {
    const a = laneBox(0, 2, 1);
    const b = laneBox(1, 2, 1);

    // Each card is wider than half, so the pair overlaps in the middle.
    expect(a.width).toBeGreaterThan(0.5);
    expect(a.left).toBe(0);
    // The second card starts before the midpoint and ends flush at the right.
    expect(b.left).toBeLessThan(0.5);
    expect(b.left + b.width).toBeCloseTo(1, 5);
  });

  test("a spanning card extends to the column's right edge", () => {
    const box = laneBox(0, 2, 2);
    expect(box.left).toBe(0);
    expect(box.width).toBeCloseTo(1, 5);
  });
});
