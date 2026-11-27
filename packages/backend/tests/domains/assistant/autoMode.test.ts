// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import { getFunctionName } from "convex/server";

process.env.SKIP_ENV_VALIDATION = "1";
const { ASSISTANT_TOOLS } = await import("../../../convex/domains/assistant/tools");
const { temporalContext } = await import("../../../convex/domains/assistant/loop");

function tool(name: string) {
  const found = ASSISTANT_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing assistant tool ${name}`);
  return found;
}

const NOW = Date.parse("2026-11-27T09:00:00.000Z");
const start = Date.parse("2026-11-27T14:00:00.000Z");

/** An event the write tools can resolve, owned by the user. */
function event(overrides: Record<string, unknown> = {}) {
  return {
    _id: "event-1",
    summary: "Focus",
    startMs: start,
    endMs: start + 3_600_000,
    allDay: false,
    status: "confirmed",
    organizer: { email: "me@example.com", self: true },
    ...overrides,
  };
}

/** A context in auto mode (unless told otherwise) that records what was
 * proposed and what was carried out. */
function contextFor(options: { auto?: boolean; row?: Record<string, unknown> } = {}) {
  const applied: string[] = [];
  const row = options.row ?? event();
  const ctx = {
    runQuery: async () => [],
    runMutation: async (reference: unknown) => {
      const name = getFunctionName(reference as never);
      if (name.endsWith("resolveEventWriteTarget")) {
        return { event: row, calendar: { accessRole: "owner", primary: true } };
      }
      if (name.endsWith("recordProposal")) return "action-1";
      return null;
    },
  } as unknown as ActionCtx;
  return {
    applied,
    tc: {
      ctx,
      userId: "user-1",
      threadId: "thread-1" as Id<"assistantThreads">,
      timeZone: "UTC",
      nowMs: NOW,
      autoApply: options.auto ?? true,
      applyNow: async (actionId: Id<"assistantActions">) => {
        applied.push(actionId);
        return "Done: added it.";
      },
    },
  };
}

const lunch = { kind: "timed", date: "2026-11-27", start: "12:30", end: "13:30" };

describe("auto mode", () => {
  test("makes a change to the user's own calendar at once", async () => {
    const { tc, applied } = contextFor();
    const outcome = await tool("create_event").run(tc, "call-1", { summary: "Lunch", time: lunch });
    expect(outcome).toMatchObject({ kind: "proposal", applied: "Done: added it." });
    expect(applied).toEqual(["action-1"]);
  });

  test("still asks for anything that invites guests or repeats", async () => {
    const guests = contextFor();
    const invite = await tool("create_event").run(guests.tc, "call-1", {
      summary: "Lunch",
      time: lunch,
      guestEmails: ["sam@example.com"],
    });
    expect(invite).toMatchObject({ kind: "proposal", held: "it invites guests" });
    expect(guests.applied).toEqual([]);

    const series = contextFor();
    const repeat = await tool("create_event").run(series.tc, "call-1", {
      summary: "Gym",
      time: lunch,
      // The 27th is a Friday: the first occurrence must be a repeating day.
      repeat: { frequency: "weekly", weekdays: ["friday"] },
    });
    expect(repeat).toMatchObject({ kind: "proposal", held: "it creates a repeating series" });
    expect(series.applied).toEqual([]);
  });

  test("asks when the model says to", async () => {
    const { tc, applied } = contextFor();
    const outcome = await tool("create_event").run(tc, "call-1", {
      summary: "Lunch",
      time: lunch,
      confirmFirst: true,
    });
    expect(outcome).toMatchObject({ kind: "proposal", held: "you asked for confirmation" });
    expect(applied).toEqual([]);
  });

  test("moves an event only when nobody else is on it", async () => {
    const solo = contextFor();
    const moved = await tool("move_event").run(solo.tc, "call-1", { eventId: "event-1", time: lunch });
    expect(moved).toMatchObject({ kind: "proposal", applied: "Done: added it." });

    const shared = contextFor({
      row: event({
        attendees: [
          { email: "me@example.com", self: true },
          { email: "ana@example.com" },
          { email: "ben@example.com" },
        ],
      }),
    });
    const held = await tool("move_event").run(shared.tc, "call-1", { eventId: "event-1", time: lunch });
    expect(held).toMatchObject({ kind: "proposal", held: "it would notify 2 guests" });
    expect(shared.applied).toEqual([]);

    // Someone else's event the user may still edit (guests can modify it).
    const theirs = contextFor({
      row: event({
        organizer: { email: "boss@example.com", self: false },
        attendees: [{ email: "me@example.com", self: true }],
        guestsCanModify: true,
      }),
    });
    const notMine = await tool("move_event").run(theirs.tc, "call-1", { eventId: "event-1", time: lunch });
    expect(notMine).toMatchObject({ kind: "proposal", held: "someone else organizes this event" });
  });

  test("never deletes without a click", async () => {
    const { tc, applied } = contextFor();
    const outcome = await tool("delete_event").run(tc, "call-1", { eventId: "event-1", scope: "thisEvent" });
    expect(outcome.kind).toBe("proposal");
    expect((outcome as { held?: string }).held).toContain("always needs");
    expect(applied).toEqual([]);
  });

  test("off means every change waits", async () => {
    const { tc, applied } = contextFor({ auto: false });
    const outcome = await tool("create_event").run(tc, "call-1", { summary: "Lunch", time: lunch });
    expect(outcome).toEqual({ kind: "proposal", actionId: "action-1", content: expect.any(String) });
    expect(applied).toEqual([]);
  });

  test("reports a change that didn't go through", async () => {
    const { tc } = contextFor();
    tc.applyNow = async () => {
      throw new Error("Google said no");
    };
    const outcome = await tool("create_event").run(tc, "call-1", { summary: "Lunch", time: lunch });
    expect(outcome).toMatchObject({ kind: "proposal", applyError: "Google said no" });
  });

  test("offers confirmFirst to the model and keeps it out of what's stored", () => {
    for (const name of ["create_event", "update_event", "move_event"]) {
      const properties = tool(name).parameters.properties as Record<string, unknown>;
      expect(properties.confirmFirst).toBeDefined();
    }
  });

  test("the clock line says whether it's on", () => {
    expect(temporalContext(NOW, "UTC", 1, true)).toContain("Auto mode is on.");
    expect(temporalContext(NOW, "UTC", 1, false)).toContain("Auto mode is off.");
    expect(temporalContext(NOW, "UTC")).toContain("Auto mode is off.");
  });
});
