// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

process.env.SKIP_ENV_VALIDATION = "1";
const { ASSISTANT_TOOLS, normalizeLegacyDeleteScope } = await import(
  "./tools"
);

function propertiesFor(name: string): Record<string, unknown> {
  const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing assistant tool ${name}`);
  const properties = tool.parameters.properties;
  if (typeof properties !== "object" || properties === null) {
    throw new Error(`Missing properties for ${name}`);
  }
  return properties as Record<string, unknown>;
}

describe("assistant recurrence tool contract", () => {
  test("creation exposes structured repeat rather than raw recurrence lines", () => {
    const properties = propertiesFor("create_event");
    expect(properties.repeat).toBeDefined();
    expect(properties.recurrence).toBeUndefined();
  });

  test("updates can turn a one-off event into a structured repeat", () => {
    const properties = propertiesFor("update_event");
    expect(properties.repeat).toBeDefined();
    expect(properties.recurrence).toBeUndefined();
  });
});

describe("assistant recurring deletion contract", () => {
  test("requires an explicit scope for new deletion proposals", () => {
    const tool = ASSISTANT_TOOLS.find(
      (candidate) => candidate.name === "delete_event",
    );
    if (!tool) throw new Error("Missing delete_event tool");
    const properties = propertiesFor("delete_event");
    expect(properties.scope).toBeDefined();
    expect(tool.parameters.required).toContain("scope");
  });

  test("defaults legacy pending proposals to one occurrence", () => {
    expect(
      normalizeLegacyDeleteScope("delete_event", { eventId: "event-1" }),
    ).toEqual({ eventId: "event-1", scope: "thisEvent" });
    expect(
      normalizeLegacyDeleteScope("delete_event", {
        eventId: "event-1",
        scope: "allEvents",
      }),
    ).toEqual({ eventId: "event-1", scope: "allEvents" });
  });

  test("previews whole-series cancellation and guest notifications", async () => {
    const tool = ASSISTANT_TOOLS.find(
      (candidate) => candidate.name === "delete_event",
    );
    if (!tool) throw new Error("Missing delete_event tool");
    let proposal: Record<string, unknown> | undefined;
    const ctx = {
      runQuery: async () => ({
        event: {
          _id: "event-1",
          summary: "Standup",
          startMs: Date.parse("2026-08-11T01:00:00.000Z"),
          endMs: Date.parse("2026-08-11T01:30:00.000Z"),
          allDay: false,
          recurringEventId: "series-1",
          organizer: { self: true },
          attendees: [{ email: "guest@example.com" }],
        },
        calendar: { accessRole: "owner" },
      }),
      runMutation: async (_reference: unknown, args: Record<string, unknown>) => {
        proposal = args;
        return "action-1";
      },
    };

    const outcome = await tool.run(
      {
        ctx: ctx as never,
        userId: "user-1",
        threadId: "thread-1" as never,
        timeZone: "Asia/Shanghai",
        nowMs: Date.parse("2026-08-11T00:00:00.000Z"),
      },
      "call-1",
      { eventId: "event-1", scope: "allEvents" },
    );

    expect(outcome.kind).toBe("proposal");
    expect(proposal?.preview).toContain("whole series");
    expect(proposal?.preview).toContain("notify 1 guest");
  });
});
