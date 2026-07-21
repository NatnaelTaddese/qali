// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
  calendarDisplayName,
  type CalendarEvent,
  layoutAllDayEvents,
  visibleAllDayMetrics,
} from "./lib";

const days = Array.from({ length: 5 }, (_, i) => new Date(2026, 0, 5 + i));

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
