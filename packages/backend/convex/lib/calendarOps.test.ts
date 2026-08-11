// @ts-expect-error Bun supplies its test module at runtime.
import { afterEach, describe, expect, test } from "bun:test";

import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

process.env.SKIP_ENV_VALIDATION = "1";
const { updateEventOp } = await import("./calendarOps");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function eventRow(overrides: Partial<Doc<"events">> = {}): Doc<"events"> {
  return {
    _id: "event-row" as Id<"events">,
    _creationTime: 1,
    userId: "user-1",
    googleEventId: "google-event",
    calendarId: "primary@example.com",
    summary: "Pay salary",
    startMs: Date.parse("2026-09-01T01:00:00.000Z"),
    endMs: Date.parse("2026-09-01T02:00:00.000Z"),
    allDay: false,
    status: "confirmed",
    googleUpdatedMs: Date.parse("2026-08-11T00:00:00.000Z"),
    organizer: { self: true },
    ...overrides,
  };
}

function actionContext(row: Doc<"events">, accessRole = "owner") {
  let queryCount = 0;
  const mutations: Record<string, unknown>[] = [];
  const ctx = {
    runQuery: async () => {
      queryCount += 1;
      if (queryCount === 1) {
        return {
          event: row,
          calendar: { accessRole },
        };
      }
      // No synced calendar row means resyncCalendar is a safe no-op in this
      // unit test; the recurring-series cache mutation still runs.
      return [];
    },
    runMutation: async (_reference: unknown, args: Record<string, unknown>) => {
      mutations.push(args);
      return null;
    },
  } as unknown as ActionCtx;
  return { ctx, mutations };
}

function liveGoogleEvent(row: Doc<"events">, overrides: Record<string, unknown> = {}) {
  return {
    id: row.googleEventId,
    summary: row.summary,
    status: row.status,
    updated: new Date(row.googleUpdatedMs).toISOString(),
    organizer: { self: true },
    start: {
      dateTime: new Date(row.startMs).toISOString(),
      timeZone: "Asia/Shanghai",
    },
    end: {
      dateTime: new Date(row.endMs).toISOString(),
      timeZone: "Asia/Shanghai",
    },
    ...overrides,
  };
}

describe("single event recurrence conversion", () => {
  test("patches the event into a master and records the series", async () => {
    const row = eventRow();
    const { ctx, mutations } = actionContext(row);
    const requests: { method: string; body?: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      requests.push({ method, body });
      if (method === "PATCH") {
        return Response.json(
          liveGoogleEvent(row, {
            updated: "2026-08-11T00:01:00.000Z",
            recurrence: ["RRULE:FREQ=MONTHLY"],
          }),
        );
      }
      return Response.json(liveGoogleEvent(row));
    }) as typeof fetch;

    await updateEventOp(ctx, row.userId, "access-token", {
      eventId: row._id,
      recurrence: ["RRULE:FREQ=MONTHLY"],
      timeZone: "Asia/Shanghai",
      operationId: "operation-1",
      expectedGoogleUpdatedMs: row.googleUpdatedMs,
    });

    expect(requests.map((request) => request.method)).toEqual(["GET", "PATCH"]);
    expect(requests[1]?.body).toMatchObject({
      recurrence: ["RRULE:FREQ=MONTHLY"],
      start: {
        dateTime: "2026-09-01T01:00:00.000Z",
        timeZone: "Asia/Shanghai",
      },
      end: {
        dateTime: "2026-09-01T02:00:00.000Z",
        timeZone: "Asia/Shanghai",
      },
    });
    expect(mutations).toContainEqual(
      expect.objectContaining({
        userId: row.userId,
        calendarId: row.calendarId,
        googleEventId: row.googleEventId,
        recurrence: ["RRULE:FREQ=MONTHLY"],
        replacedEventId: row._id,
      }),
    );
  });

  test("rejects a stale proposal before patching Google", async () => {
    const row = eventRow();
    const { ctx } = actionContext(row);
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json(
        liveGoogleEvent(row, {
          summary: "Changed elsewhere",
          updated: "2026-08-11T00:02:00.000Z",
        }),
      );
    }) as typeof fetch;

    await expect(
      updateEventOp(ctx, row.userId, "access-token", {
        eventId: row._id,
        recurrence: ["RRULE:FREQ=MONTHLY"],
        timeZone: "Asia/Shanghai",
        expectedGoogleUpdatedMs: row.googleUpdatedMs,
      }),
    ).rejects.toThrow("changed after");
    expect(methods).toEqual(["GET"]);
  });

  test("does not replace the rule of an existing recurring instance", async () => {
    const row = eventRow({ recurringEventId: "existing-master" });
    const { ctx } = actionContext(row);
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return Response.json({});
    }) as typeof fetch;

    await expect(
      updateEventOp(ctx, row.userId, "access-token", {
        eventId: row._id,
        recurrence: ["RRULE:FREQ=DAILY"],
        timeZone: "Asia/Shanghai",
      }),
    ).rejects.toThrow("already part");
    expect(fetched).toBe(false);
  });

  test("rejects conversion on a read-only calendar before Google is called", async () => {
    const row = eventRow();
    const { ctx } = actionContext(row, "reader");
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return Response.json({});
    }) as typeof fetch;

    await expect(
      updateEventOp(ctx, row.userId, "access-token", {
        eventId: row._id,
        recurrence: ["RRULE:FREQ=MONTHLY"],
        timeZone: "Asia/Shanghai",
      }),
    ).rejects.toThrow("read-only");
    expect(fetched).toBe(false);
  });
});
