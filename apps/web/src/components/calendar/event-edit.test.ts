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
  reminders: null,
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

describe("event edit reminders", () => {
  const event = { attendees: [] } as unknown as CalendarEvent;

  test("an unchanged reminder list adds nothing to the patch", () => {
    const next: EventFormValue = { ...initial, reminders: null };
    expect("reminders" in diffEvent(initial, next, event, "UTC")).toBe(false);
    const explicit: EventFormValue = {
      ...initial,
      reminders: [
        { method: "popup", minutes: 10 },
        { method: "email", minutes: 30 },
      ],
    };
    const reordered: EventFormValue = {
      ...initial,
      reminders: [
        { method: "email", minutes: 30 },
        { method: "popup", minutes: 10 },
      ],
    };
    expect("reminders" in diffEvent(explicit, reordered, event, "UTC")).toBe(false);
  });

  test("an explicit list is sent normalised, and null reverts to the default", () => {
    const next: EventFormValue = {
      ...initial,
      reminders: [
        { method: "popup", minutes: 60 },
        { method: "popup", minutes: 10 },
        { method: "popup", minutes: 10 },
      ],
    };
    expect(diffEvent(initial, next, event, "UTC").reminders).toEqual([
      { method: "popup", minutes: 10 },
      { method: "popup", minutes: 60 },
    ]);
    expect(diffEvent(next, initial, event, "UTC").reminders).toBeNull();
    expect(diffEvent(initial, { ...initial, reminders: [] }, event, "UTC").reminders).toEqual([]);
  });
});
