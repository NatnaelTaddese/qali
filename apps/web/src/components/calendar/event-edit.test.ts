// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import type { EventFormValue } from "./event-form";
import type { CalendarEvent } from "./lib";

process.env.SKIP_ENV_VALIDATION = "1";
const { diffEvent, finalizeEventPatch } = await import("./event-edit");

const initial: EventFormValue = {
  summary: "Pay salary",
  description: "",
  location: "",
  meet: false,
  startMs: Date.parse("2026-09-01T09:00:00.000Z"),
  endMs: Date.parse("2026-09-01T10:00:00.000Z"),
  allDay: false,
  isPrivate: false,
  busy: true,
  guests: [],
  recurrence: null,
};

describe("event edit recurrence", () => {
  test("saves the visible Repeat control with a time zone", () => {
    const next: EventFormValue = {
      ...initial,
      recurrence: {
        freq: "MONTHLY",
        interval: 1,
        end: { kind: "never" },
      },
    };
    const patch = diffEvent(
      initial,
      next,
      { attendees: [] } as unknown as CalendarEvent,
      "Asia/Shanghai",
    );

    expect(patch.recurrence).toEqual(["RRULE:FREQ=MONTHLY"]);
    expect(finalizeEventPatch(patch, "thisEvent", "Asia/Shanghai")).toEqual({
      recurrence: ["RRULE:FREQ=MONTHLY"],
      timeZone: "Asia/Shanghai",
    });
  });

  test("does not add a time zone to an ordinary single-event metadata edit", () => {
    const patch = { summary: "Salary day" };
    expect(finalizeEventPatch(patch, "thisEvent", "Asia/Shanghai")).toBe(patch);
  });
});
