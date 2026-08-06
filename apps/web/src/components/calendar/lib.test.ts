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
  addPages,
  eventQueryRange,
  MS_PER_DAY,
  nextFreeSlot,
  pageDays,
  pageStart,
  STRIP_SIDE_DAYS,
  stripDays,
  VIEW_BUFFER,
  VIEW_COLUMNS,
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

describe("nextFreeSlot", () => {
  const at = (h: number, m = 0) => dayStart + (h * 60 + m) * 60_000;
  // A moment before the test day so "today" logic never kicks in for it.
  const beforeDay = dayStart - MS_PER_DAY;

  test("defaults to 9:00 AM for 30 minutes on an empty future day", () => {
    expect(nextFreeSlot(dayStart, [], beforeDay)).toEqual({
      startMs: at(9),
      endMs: at(9, 30),
    });
  });

  test("skips past an event that blocks the 9 AM slot", () => {
    const slot = nextFreeSlot(dayStart, [timedEvent("a", 9, 0, 10, 0)], beforeDay);
    expect(slot).toEqual({ startMs: at(10), endMs: at(10, 30) });
  });

  test("finds the gap between two meetings", () => {
    const events = [
      timedEvent("a", 9, 0, 9, 30),
      timedEvent("b", 10, 0, 11, 0),
    ];
    expect(nextFreeSlot(dayStart, events, beforeDay)).toEqual({
      startMs: at(9, 30),
      endMs: at(10),
    });
  });

  test("ignores all-day events", () => {
    const slot = nextFreeSlot(dayStart, [allDayEvent("a", 0, 1)], beforeDay);
    expect(slot).toEqual({ startMs: at(9), endMs: at(9, 30) });
  });

  test("starts from the next snap boundary when the day is today", () => {
    const now = at(13, 5);
    expect(nextFreeSlot(dayStart, [], now)).toEqual({
      startMs: at(13, 15),
      endMs: at(13, 45),
    });
  });

  test("stays at 9 AM on a past day even though now is later", () => {
    // now is on a day after the target: the target isn't today, so 9 AM wins
    // rather than leaking the current time onto a past day.
    const now = dayStart + MS_PER_DAY + at(15) - dayStart;
    expect(nextFreeSlot(dayStart, [], now)).toEqual({
      startMs: at(9),
      endMs: at(9, 30),
    });
  });

  test("falls back to the last slot before midnight on a full day", () => {
    const events = [timedEvent("all", 0, 0, 24, 0)];
    const slot = nextFreeSlot(dayStart, events, beforeDay);
    expect(slot).toEqual({ startMs: at(23, 30), endMs: at(24) });
  });
});

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

  test("packs lanes globally but clamps spans to the visible range", () => {
    const events = [
      allDayEvent("first", 0, 3), // [0,2]
      allDayEvent("second", 0, 3), // [0,2]
      allDayEvent("continuing", 1, 5), // [1,4]
    ];
    const byId = (visibleStartIdx: number, visibleEndIdx: number) =>
      Object.fromEntries(
        layoutAllDayEvents(days, events, visibleStartIdx, visibleEndIdx).map(
          (entry) => [entry.event._id, entry],
        ),
      );

    // Full window: lanes packed globally, spans untouched.
    expect(byId(0, 4).continuing).toMatchObject({
      lane: 2,
      startIdx: 1,
      endIdx: 4,
    });

    // Scrolled so `first`/`second` leave the window: `continuing` keeps its
    // global lane 2 (rows never repack) but its span clamps to the visible
    // range, so the card renders narrower.
    const scrolled = byId(3, 4);
    expect(scrolled.first).toBeUndefined();
    expect(scrolled.second).toBeUndefined();
    expect(scrolled.continuing).toMatchObject({
      lane: 2,
      startIdx: 3,
      endIdx: 4,
    });
  });

  test("orders lanes by true start, not input order", () => {
    // `late` is declared first but starts a day later, so `early` still wins the
    // top lane — the two never swap rows as the strip scrolls.
    const laneById = Object.fromEntries(
      layoutAllDayEvents(days, [
        allDayEvent("late", 1, 5), // days 1–4
        allDayEvent("early", 0, 2), // days 0–1, overlaps `late` on day 1
      ]).map(({ event, lane }) => [event._id, lane]),
    );

    expect(laneById).toEqual({ early: 0, late: 1 });
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

describe("strip geometry", () => {
  test("side buffer stays derived from the per-view page buffer", () => {
    expect(STRIP_SIDE_DAYS.week).toBe(VIEW_BUFFER.week * VIEW_COLUMNS.week);
    expect(STRIP_SIDE_DAYS.day).toBe(VIEW_BUFFER.day * VIEW_COLUMNS.day);
  });

  test("stripDays returns the same Date object for the same day", () => {
    const a = stripDays(new Date(2026, 0, 5), 7, 3);
    const b = stripDays(new Date(2026, 0, 6), 7, 3);
    // Overlapping columns must be referentially equal or the memoized day
    // columns all re-render on every anchor step.
    const shared = a.filter((day) => b.includes(day));
    expect(shared.length).toBeGreaterThan(0);
  });
});

describe("eventQueryRange", () => {
  /** The rendered span for an anchor, as [startMs, endMs). */
  function renderedRange(view: "day" | "week" | "month", anchor: Date) {
    if (view === "month") {
      const buffer = VIEW_BUFFER.month;
      const first = pageDays("month", addPages("month", anchor, -buffer));
      const last = pageDays("month", addPages("month", anchor, buffer));
      return {
        startMs: first[0].getTime(),
        endMs: last[last.length - 1].getTime() + MS_PER_DAY,
      };
    }
    const columns = VIEW_COLUMNS[view];
    const days = stripDays(anchor, columns, STRIP_SIDE_DAYS[view]);
    return {
      startMs: days[0].getTime(),
      endMs: days[days.length - 1].getTime() + MS_PER_DAY,
    };
  }

  // The window is quantized, so it only changes when the anchor crosses a
  // period boundary. Until it does, the retained previous result is all the
  // grid has — if it doesn't span the strip being rendered, those columns show
  // no events. A settle can move the anchor by at most the buffer, so the
  // window for any anchor must cover every strip reachable in one settle.
  for (const view of ["day", "week"] as const) {
    test(`${view} window covers every strip reachable in one settle`, () => {
      const maxDelta = STRIP_SIDE_DAYS[view];
      for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const anchor = new Date(2026, 0, 5 + dayOffset);
        const window = eventQueryRange(view, anchor);
        for (let delta = -maxDelta; delta <= maxDelta; delta++) {
          const next = new Date(2026, 0, 5 + dayOffset + delta);
          const rendered = renderedRange(view, next);
          expect(window.startMs).toBeLessThanOrEqual(rendered.startMs);
          expect(window.endMs).toBeGreaterThanOrEqual(rendered.endMs);
        }
      }
    });
  }

  test("month window covers every page reachable in one settle", () => {
    const maxDelta = VIEW_BUFFER.month;
    for (let monthOffset = 0; monthOffset < 12; monthOffset++) {
      const anchor = pageStart("month", new Date(2026, monthOffset, 1));
      const window = eventQueryRange("month", anchor);
      for (let delta = -maxDelta; delta <= maxDelta; delta++) {
        const rendered = renderedRange("month", addPages("month", anchor, delta));
        expect(window.startMs).toBeLessThanOrEqual(rendered.startMs);
        expect(window.endMs).toBeGreaterThanOrEqual(rendered.endMs);
      }
    }
  });

  test("window is stable while the anchor stays inside its period", () => {
    const monday = pageStart("week", new Date(2026, 0, 7));
    const base = eventQueryRange("week", monday);
    for (let i = 1; i < 7; i++) {
      const sameWeek = new Date(monday.getTime() + i * MS_PER_DAY);
      expect(eventQueryRange("week", sameWeek)).toEqual(base);
    }
  });
});
