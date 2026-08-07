// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  assistantRangeToEventTime,
  formatAssistantAllDayRange,
  googleEventIdForOperation,
  isDateKey,
  mergeLiveAttendees,
  shiftRecurringMasterRange,
} from "./assistantLogic";

describe("assistant all-day ranges", () => {
  test("preserves date text independently of a timezone", () => {
    const time = assistantRangeToEventTime({
      kind: "allDay",
      startDate: "2026-08-03",
      endDate: "2026-08-05",
    });
    expect(new Date(time.startMs).toISOString().slice(0, 10)).toBe("2026-08-03");
    expect(new Date(time.endMs).toISOString().slice(0, 10)).toBe("2026-08-05");
    expect(time.allDay).toBe(true);
    expect(formatAssistantAllDayRange("2026-08-03", "2026-08-05")).toContain(
      "Mon, Aug 3–Tue, Aug 4",
    );
  });

  test("rejects impossible and non-positive date ranges", () => {
    expect(isDateKey("2026-02-29")).toBe(false);
    expect(() =>
      assistantRangeToEventTime({
        kind: "allDay",
        startDate: "2026-08-03",
        endDate: "2026-08-03",
      }),
    ).toThrow();
  });

  test("requires a timed event to end after it starts", () => {
    expect(() =>
      assistantRangeToEventTime({ kind: "timed", startMs: 10, endMs: 10 }),
    ).toThrow("end after");
    expect(
      assistantRangeToEventTime({ kind: "timed", startMs: 10, endMs: 20 }),
    ).toEqual({ startMs: 10, endMs: 20, allDay: false });
  });
});

describe("recurring event type changes", () => {
  const zone = "America/New_York";

  test("keeps a requested wall time when winter occurrence edits a summer master", () => {
    const shifted = shiftRecurringMasterRange({
      occurrenceStartMs: Date.UTC(2026, 0, 15),
      occurrenceEndMs: Date.UTC(2026, 0, 16),
      occurrenceAllDay: true,
      masterStartMs: Date.UTC(2026, 6, 15),
      masterEndMs: Date.UTC(2026, 6, 16),
      masterAllDay: true,
      targetStartMs: Date.UTC(2026, 0, 15, 14), // 9am EST
      targetEndMs: Date.UTC(2026, 0, 15, 15),
      targetAllDay: false,
      timeZone: zone,
    });

    expect(new Date(shifted.startMs).toISOString()).toBe(
      "2026-07-15T13:00:00.000Z",
    );
    expect(shifted.endMs - shifted.startMs).toBe(60 * 60 * 1000);
  });

  test("converts a timed summer master to its local all-day date", () => {
    const shifted = shiftRecurringMasterRange({
      occurrenceStartMs: Date.UTC(2026, 0, 15, 14),
      occurrenceEndMs: Date.UTC(2026, 0, 15, 15),
      occurrenceAllDay: false,
      masterStartMs: Date.UTC(2026, 6, 15, 13),
      masterEndMs: Date.UTC(2026, 6, 15, 14),
      masterAllDay: false,
      targetStartMs: Date.UTC(2026, 0, 15),
      targetEndMs: Date.UTC(2026, 0, 16),
      targetAllDay: true,
      timeZone: zone,
    });

    expect(new Date(shifted.startMs).toISOString()).toBe(
      "2026-07-15T00:00:00.000Z",
    );
    expect(new Date(shifted.endMs).toISOString()).toBe(
      "2026-07-16T00:00:00.000Z",
    );
  });
});

describe("mergeLiveAttendees", () => {
  test("preserves live RSVP/resource fields and protected attendees", () => {
    const merged = mergeLiveAttendees(
      [
        { email: "owner@example.com", organizer: true, responseStatus: "accepted" },
        {
          email: "room@example.com",
          resource: true,
          responseStatus: "accepted",
          comment: "Projector",
        },
        { email: "removed@example.com", responseStatus: "tentative" },
      ],
      [
        { email: "room@example.com" },
        { email: "new@example.com", optional: true },
      ],
    );

    expect(merged).toContainEqual({
      email: "room@example.com",
      resource: true,
      responseStatus: "accepted",
      comment: "Projector",
    });
    expect(merged).toContainEqual({
      email: "owner@example.com",
      organizer: true,
      responseStatus: "accepted",
    });
    expect(merged.some((a) => a.email === "removed@example.com")).toBe(false);
  });
});

test("operation IDs become stable Google IDs", () => {
  const id = googleEventIdForOperation("123e4567-e89b-12d3-a456-426614174000");
  expect(id).toBe("qali123e4567e89b12d3a456426614174000");
  expect(id).toMatch(/^[a-v0-9]+$/);
});
