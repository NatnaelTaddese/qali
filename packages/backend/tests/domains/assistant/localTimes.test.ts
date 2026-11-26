// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import {
  instantsToLocalTimed,
  localTimedRangeToInstants,
  parseClockTime,
  upcomingDatesLine,
} from "../../../convex/domains/assistant/eventLogic";

process.env.SKIP_ENV_VALIDATION = "1";
const { ASSISTANT_TOOLS } = await import("../../../convex/domains/assistant/tools");
const { temporalContext } = await import("../../../convex/domains/assistant/loop");

const iso = (ms: number) => new Date(ms).toISOString();

function tool(name: string) {
  const found = ASSISTANT_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing assistant tool ${name}`);
  return found;
}

/** A context whose first query returns `events`, and which records what a
 * proposal would store. */
function contextFor(timeZone: string, events: Array<Record<string, unknown>> = []) {
  const stored: Array<{ input: string; preview: string }> = [];
  let queries = 0;
  const ctx = {
    runQuery: async () => (queries++ === 0 ? events : []),
    runMutation: async (_reference: unknown, args: { input: string; preview: string }) => {
      stored.push(args);
      return "action-1";
    },
  } as unknown as ActionCtx;
  return {
    stored,
    tc: {
      ctx,
      userId: "user-1",
      threadId: "thread-1" as Id<"assistantThreads">,
      timeZone,
      nowMs: Date.parse("2026-11-27T09:00:00.000Z"),
    },
  };
}

describe("local wall-clock times", () => {
  test("parse 24-hour times, refusing anything else", () => {
    expect(parseClockTime("09:30")).toBe(570);
    expect(parseClockTime("9:05")).toBe(545);
    expect(parseClockTime("24:00")).toBe(1440);
    for (const bad of ["24:30", "12:60", "2pm", "1230", ""]) {
      expect(parseClockTime(bad)).toBeNull();
    }
  });

  test("resolve a local range in the user's zone, DST included", () => {
    const addis = localTimedRangeToInstants(
      { kind: "timed", date: "2026-11-26", start: "12:30", end: "13:30" },
      "Africa/Addis_Ababa",
    );
    expect(iso(addis.startMs)).toBe("2026-11-26T09:30:00.000Z");
    expect(iso(addis.endMs)).toBe("2026-11-26T10:30:00.000Z");

    const london = localTimedRangeToInstants(
      { kind: "timed", date: "2026-07-01", start: "09:00", end: "10:00" },
      "Europe/London",
    );
    expect(iso(london.startMs)).toBe("2026-07-01T08:00:00.000Z");
  });

  test("run an end at or before the start past midnight, but refuse zero length", () => {
    const late = localTimedRangeToInstants(
      { kind: "timed", date: "2026-11-27", start: "23:00", end: "01:00" },
      "UTC",
    );
    expect(iso(late.endMs)).toBe("2026-11-28T01:00:00.000Z");
    expect(() =>
      localTimedRangeToInstants({ kind: "timed", date: "2026-11-27", start: "10:00", end: "10:00" }, "UTC"),
    ).toThrow("end after it starts");
    expect(() =>
      localTimedRangeToInstants({ kind: "timed", date: "2026-11-27", start: "2pm", end: "3pm" }, "UTC"),
    ).toThrow("24-hour");
  });

  test("round-trip instants to the shape the write tools take", () => {
    const start = Date.parse("2026-11-27T22:00:00.000Z");
    expect(instantsToLocalTimed(start, start + 3_600_000, "UTC")).toEqual({
      date: "2026-11-27",
      start: "22:00",
      end: "23:00",
    });
    // Ending at the next midnight reads as 24:00 on the same day.
    expect(instantsToLocalTimed(start, start + 2 * 3_600_000, "UTC")).toEqual({
      date: "2026-11-27",
      start: "22:00",
      end: "24:00",
    });
    expect(instantsToLocalTimed(start, start + 5 * 3_600_000, "UTC")).toEqual({
      date: "2026-11-27",
      start: "22:00",
      end: "03:00",
      endDate: "2026-11-28",
    });
  });
});

describe("the clock line", () => {
  test("lists the next two weeks with weekdays and this week's bounds", () => {
    const line = upcomingDatesLine("2026-11-27", 1);
    expect(line).toContain("This week runs Mon 2026-11-23 to Sun 2026-11-29");
    expect(line).toContain("Fri 2026-11-27 (today)");
    expect(line).toContain("Sat 2026-11-28 (tomorrow)");
    expect(line).toContain("Tue 2026-12-01");
    expect(line).toContain("Thu 2026-12-10");
    expect(line).not.toContain("2026-12-11");
  });

  test("follows the user's week start", () => {
    expect(upcomingDatesLine("2026-11-27", 0)).toContain("This week runs Sun 2026-11-22 to Sat 2026-11-28");
    expect(upcomingDatesLine("2026-11-27", 6)).toContain("This week runs Sat 2026-11-21 to Fri 2026-11-27");
  });

  test("states the local date and no epoch value", () => {
    // 1am on the 28th in Addis is still the 27th in UTC.
    const line = temporalContext(Date.parse("2026-11-27T22:00:00.000Z"), "Africa/Addis_Ababa");
    expect(line).toContain("Today's local date is 2026-11-28");
    expect(line).toContain("Sat 2026-11-28 (today)");
    expect(line).not.toMatch(/\d{13}/);
  });
});

describe("write tools take local times", () => {
  test("create_event stores the instants a confirm applies, in the user's zone", async () => {
    const { tc, stored } = contextFor("Africa/Addis_Ababa");
    const outcome = await tool("create_event").run(tc, "call-1", {
      summary: "Lunch with Sam",
      time: { kind: "timed", date: "2026-11-26", start: "12:30", end: "13:30" },
    });
    expect(outcome.kind).toBe("proposal");
    const input = JSON.parse(stored[0]!.input);
    expect(input.time).toEqual({
      kind: "timed",
      startMs: Date.parse("2026-11-26T09:30:00.000Z"),
      endMs: Date.parse("2026-11-26T10:30:00.000Z"),
    });
    expect(stored[0]!.preview).toContain("12:30");
  });

  test("create_event shows the model local fields, not epoch values", () => {
    const text = JSON.stringify(tool("create_event").parameters);
    expect(text).toContain('"start"');
    expect(text).not.toContain("startMs");
  });

  test("a bad local time comes back as an error the model can fix", async () => {
    const { tc, stored } = contextFor("UTC");
    const outcome = await tool("create_event").run(tc, "call-1", {
      summary: "Call",
      time: { kind: "timed", date: "2026-11-26", start: "2pm", end: "3pm" },
    });
    expect(outcome).toMatchObject({ kind: "result", isError: true });
    expect(stored).toHaveLength(0);
  });

  test("all-day ranges pass through untouched", async () => {
    const { tc, stored } = contextFor("Africa/Addis_Ababa");
    await tool("create_event").run(tc, "call-1", {
      summary: "Offsite",
      time: { kind: "allDay", startDate: "2026-12-01", endDate: "2026-12-02" },
    });
    expect(JSON.parse(stored[0]!.input).time).toEqual({
      kind: "allDay",
      startDate: "2026-12-01",
      endDate: "2026-12-02",
    });
  });
});

describe("list_events rows", () => {
  const base = {
    startMs: Date.parse("2026-11-27T14:00:00.000Z"),
    endMs: Date.parse("2026-11-27T15:00:00.000Z"),
    allDay: false,
    status: "confirmed",
  };

  test("name a few guests, count the rest, and mark the user's response", async () => {
    const attendees = [
      { email: "me@example.com", self: true, responseStatus: "declined" },
      ...["Ana", "Ben", "Cleo", "Dev", "Eve", "Fay", "Gus", "Hal", "Ida", "Jon", "Kim", "Lou", "Max", "Ned"].map((name) => ({
        email: `${name.toLowerCase()}@example.com`,
        displayName: name,
      })),
    ];
    const { tc } = contextFor("UTC", [
      { ...base, _id: "e1", summary: "All hands", attendees, organizer: { email: "boss@example.com" } },
    ]);
    const outcome = await tool("list_events").run(tc, "call-1", { fromDate: "2026-11-27" });
    const { events } = JSON.parse(outcome.content);
    expect(events[0]).toMatchObject({
      summary: "All hands",
      role: "guest",
      myResponse: "declined",
      guests: ["Ana", "Ben", "Cleo", "Dev", "Eve", "Fay", "Gus", "Hal", "Ida", "Jon", "Kim", "Lou"],
      moreGuests: 2,
    });
    expect(outcome.content).not.toContain("@example.com");
  });

  test("cut a crowded range short with a note instead of failing", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...base,
      _id: `event-${i}`,
      summary: `Meeting number ${i} with a reasonably long title`,
      startMs: base.startMs + i * 60_000,
      endMs: base.endMs + i * 60_000,
      location: "Conference room on the third floor",
    }));
    const { tc } = contextFor("UTC", many);
    const outcome = await tool("list_events").run(tc, "call-1", { fromDate: "2026-11-27" });
    expect(outcome.kind).toBe("result");
    expect((outcome as { isError?: boolean }).isError).toBeUndefined();
    const result = JSON.parse(outcome.content);
    expect(result.events.length).toBeGreaterThan(40);
    expect(result.omitted).toBe(200 - result.events.length);
    expect(result.note).toContain("2026-11-27");
    expect(outcome.content.length).toBeLessThan(16_000);
  });
});

describe("the unbacked-claim check", () => {
  test("catches a reply that says a change was made or proposed", async () => {
    const { CLAIMS_A_CHANGE } = await import("../../../convex/domains/assistant/loop");
    for (const claim of [
      "I've proposed **Lunch with Sam**, Tuesday at 12:30.",
      "I’ve put a proposal in front of you: Dentist, Monday 9am.",
      "I scheduled it for Friday.",
      "It's waiting for your confirmation.",
      "Confirm to send the invite.",
      "I have moved the 1:1 to Friday.",
    ]) {
      expect(CLAIMS_A_CHANGE.test(claim)).toBe(true);
    }
    for (const plain of [
      "Tomorrow you have three things.",
      "Friday at 2:30pm is free. Want me to move it there?",
      "You declined the 4pm Hiring sync, so that hour is free.",
      "The standup is scheduled daily at 9:30.",
    ]) {
      expect(CLAIMS_A_CHANGE.test(plain)).toBe(false);
    }
  });
});
