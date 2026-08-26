// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import type { Doc, Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import type {
  CalendarProviderAdapter,
  CreateEventRequest,
} from "../../../convex/integrations/calendar/types";

process.env.SKIP_ENV_VALIDATION = "1";
const { ASSISTANT_TOOLS, applyProposal } = await import(
  "../../../convex/domains/assistant/tools"
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

describe("assistant confirmed writes", () => {
  test("stores neutral provider versions on new attendee proposals", async () => {
    const tool = ASSISTANT_TOOLS.find(
      (candidate) => candidate.name === "update_event",
    );
    if (!tool) throw new Error("Missing update_event tool");
    let proposalInput = "";
    const event = {
      _id: "event-1",
      userId: "user-1",
      summary: "Planning",
      startMs: 1_000,
      endMs: 2_000,
      allDay: false,
      status: "confirmed",
      providerEventId: "provider-event-1",
      providerUpdatedMs: 20,
      organizer: { self: true },
    };
    const ctx = {
      runMutation: async (_reference: unknown, args: Record<string, unknown>) => {
        if (args.eventId === "event-1") {
          return {
            event,
            calendar: { accessRole: "owner" },
          };
        }
        proposalInput = String(args.input);
        return "action-1";
      },
      runQuery: async () => null,
    } as unknown as ActionCtx;

    const outcome = await tool.run(
      {
        ctx,
        userId: "user-1",
        threadId: "thread-1" as Id<"assistantThreads">,
        timeZone: "UTC",
        nowMs: 1,
      },
      "call-1",
      { eventId: "event-1", guestEmails: ["guest@example.com"] },
    );

    expect(outcome.kind).toBe("proposal");
    expect(JSON.parse(proposalInput)).toMatchObject({
      expectedProviderUpdatedMs: 20,
    });
    expect(proposalInput).not.toContain("expectedGoogleUpdatedMs");
  });

  test("applies a confirmed create through a non-Google adapter", async () => {
    let mirroredEventId: string | undefined;
    const adapter = {
      provider: "microsoft",
      capabilities: {
        contacts: false,
        recurringEvents: true,
        attendeeMembershipUpdates: true,
        rsvp: true,
        removeSelf: true,
        conference: { create: false, add: false, remove: false },
        idempotentCreate: true,
        idempotentUpdate: true,
        idempotentResponse: true,
        idempotentDelete: true,
      },
      async createEvent(request: CreateEventRequest) {
        return {
          id: "outlook-event-1",
          calendarId: request.calendarId,
          summary: request.event.summary,
          startMs: request.event.startMs,
          endMs: request.event.endMs,
          allDay: false,
          status: "confirmed" as const,
          updatedMs: 1,
        };
      },
      async reconcileAmbiguousCreate() {
        return null;
      },
    } as unknown as CalendarProviderAdapter;
    const ctx = {
      runQuery: async () => null,
      runMutation: async (_reference: unknown, args: Record<string, unknown>) => {
        if ("requestedCalendarId" in args) {
          return {
            connectionId: "connection-1",
            localCalendarId: "calendar-1",
            providerCalendarId: "outlook-primary",
          };
        }
        if ("kind" in args && "idempotencyKey" in args) {
          return { state: "claimed", reconcileOnly: false };
        }
        if ("status" in args && "attemptId" in args) return true;
        if ("event" in args) {
          mirroredEventId = (args.event as { id?: string }).id;
        }
        return null;
      },
    } as unknown as ActionCtx;
    const action = {
      _id: "action-1" as Id<"assistantActions">,
      _creationTime: 1,
      threadId: "thread-1" as Id<"assistantThreads">,
      userId: "user-1",
      toolCallId: "call-1",
      tool: "create_event",
      input: JSON.stringify({
        summary: "Planning",
        time: { kind: "timed", startMs: 1_000, endMs: 2_000 },
        timeZone: "UTC",
      }),
      preview: "Create Planning",
      operationId: "assistant-operation-1",
      status: "applying" as const,
      createdAt: 1,
    } satisfies Doc<"assistantActions">;

    const summary = await applyProposal(ctx, "user-1", action, {
      getAdapter: async () => adapter,
      refreshCalendar: async () => {},
    });

    expect(adapter.provider).toBe("microsoft");
    expect(summary).toBe("Created “Planning”.");
    expect(mirroredEventId).toBe("outlook-event-1");
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
          providerSeriesId: "series-1",
          organizer: { self: true },
          attendees: [{ email: "guest@example.com" }],
        },
        calendar: { accessRole: "owner" },
      }),
      runMutation: async (_reference: unknown, args: Record<string, unknown>) => {
        if (args.eventId === "event-1" && args.userId === "user-1") {
          return {
            event: {
              _id: "event-1",
              summary: "Standup",
              startMs: Date.parse("2026-08-11T01:00:00.000Z"),
              endMs: Date.parse("2026-08-11T01:30:00.000Z"),
              allDay: false,
              providerSeriesId: "series-1",
              organizer: { self: true },
              attendees: [{ email: "guest@example.com" }],
            },
            calendar: { accessRole: "owner" },
          };
        }
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
