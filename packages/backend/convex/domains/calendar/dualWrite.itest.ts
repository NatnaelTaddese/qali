/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import schema from "../../schema";

const modules = import.meta.glob("../../**/*.ts");

const USER = "user_dw";

const googleEvent = {
  googleEventId: "g-evt",
  calendarId: "primary",
  startMs: 1_000,
  endMs: 2_000,
  allDay: false,
  status: "confirmed",
  googleUpdatedMs: 777,
};

async function preparePrimaryCalendar(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.calendarSync.ensureSyncState, { userId: USER });
  const connectionId = await t.run(async (ctx) => {
    const connection = await ctx.db
      .query("calendarConnections")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", USER).eq("provider", "google"),
      )
      .unique();
    return connection!._id;
  });
  const attemptId = await t.mutation(internal.calendarSync.claimSyncLease, {
    connectionId,
  });
  await t.mutation(internal.calendarSync.reconcileCalendars, {
    connectionId,
    attemptId: attemptId!,
    calendars: [
      {
        id: "primary",
        primary: true,
        writable: true,
      },
    ],
  });
  await t.mutation(internal.calendarSync.recordSyncOutcome, {
    connectionId,
    attemptId: attemptId!,
    status: "idle",
    active: true,
  });
}

describe("calendar dual-write", () => {
  test("repairs missing neutral event references before returning a write target", async () => {
    const t = convexTest(schema, modules);
    const { eventId } = await t.run(async (ctx) => {
      await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: "legacy-primary",
        accessRole: "owner",
        primary: true,
        selected: true,
      });
      const eventId = await ctx.db.insert("events", {
        userId: USER,
        googleEventId: "legacy-event",
        calendarId: "legacy-primary",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 9,
      });
      return { eventId };
    });

    const target = await t.mutation(internal.calendar.resolveEventWriteTarget, {
      userId: USER,
      eventId,
    });
    expect(target).toMatchObject({
      providerCalendarId: "legacy-primary",
      providerEventId: "legacy-event",
    });
    expect(target?.connectionId).toBeDefined();
    expect(target?.localCalendarId).toBeDefined();

    const repaired = await t.run((ctx) => ctx.db.get(eventId));
    expect(repaired).toMatchObject({
      connectionId: target?.connectionId,
      localCalendarId: target?.localCalendarId,
      providerEventId: "legacy-event",
      providerUpdatedMs: 9,
    });
  });

  test("claims and settles one authoritative calendar operation per assistant key", async () => {
    const t = convexTest(schema, modules);
    await preparePrimaryCalendar(t);
    const target = await t.mutation(internal.calendar.resolveCreateTarget, {
      userId: USER,
    });
    const claim = await t.mutation(internal.calendar.claimCalendarOperation, {
      userId: USER,
      ...target,
      idempotencyKey: "assistant-operation-1",
      kind: "create",
      attemptId: "attempt-1",
    });
    expect(claim).toMatchObject({ state: "claimed", reconcileOnly: false });
    expect(
      await t.mutation(internal.calendar.settleCalendarOperation, {
        userId: USER,
        connectionId: target.connectionId,
        idempotencyKey: "assistant-operation-1",
        attemptId: "attempt-1",
        status: "succeeded",
        providerEventId: "provider-event-1",
      }),
    ).toBe(true);

    const replay = await t.mutation(internal.calendar.claimCalendarOperation, {
      userId: USER,
      ...target,
      idempotencyKey: "assistant-operation-1",
      kind: "create",
      attemptId: "attempt-2",
    });
    expect(replay).toEqual({
      state: "succeeded",
      providerEventId: "provider-event-1",
    });
  });

  test("upsertEvent stamps the neutral mirror and lazily creates the connection", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.calendar.upsertEvent, {
      userId: USER,
      event: googleEvent,
    });

    const { event, connectionCount, connectionId, connectionState } = await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_user_and_start", (q) => q.eq("userId", USER))
        .unique();
      const connections = await ctx.db
        .query("calendarConnections")
        .withIndex("by_user_and_provider", (q) =>
          q.eq("userId", USER).eq("provider", "google"),
        )
        .collect();
      return {
        event,
        connectionCount: connections.length,
        connectionId: connections[0]?._id,
        connectionState: connections[0]
          ? await ctx.db
              .query("connectionSyncState")
              .withIndex("by_connection", (q) =>
                q.eq("connectionId", connections[0]!._id),
              )
              .unique()
          : null,
      };
    });

    // A connection was created on demand (backfill may have missed this user).
    expect(connectionCount).toBe(1);
    expect(connectionState?.status).toBe("idle");
    // Neutral fields mirror the Google-named ones; legacy columns untouched.
    expect(event?.connectionId).toBe(connectionId);
    expect(event?.providerEventId).toBe("g-evt");
    expect(event?.providerUpdatedMs).toBe(777);
    expect(event?.googleEventId).toBe("g-evt");
  });

  test("a second upsert reuses the same connection (idempotent)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.calendar.upsertEvent, {
      userId: USER,
      event: googleEvent,
    });
    await t.mutation(internal.calendar.upsertEvent, {
      userId: USER,
      event: { ...googleEvent, summary: "updated" },
    });

    const connections = await t.run((ctx) =>
      ctx.db
        .query("calendarConnections")
        .withIndex("by_user_and_provider", (q) =>
          q.eq("userId", USER).eq("provider", "google"),
        )
        .collect(),
    );
    expect(connections).toHaveLength(1);
  });

  test("upsertRecurringSeries stamps connectionId + providerEventId", async () => {
    const t = convexTest(schema, modules);
    await preparePrimaryCalendar(t);
    await t.mutation(internal.calendar.upsertRecurringSeries, {
      userId: USER,
      calendarId: "primary",
      googleEventId: "series-1",
      recurrence: ["RRULE:FREQ=WEEKLY"],
      sourceUpdatedMs: 5,
    });

    const series = await t.run((ctx) =>
      ctx.db
        .query("recurringSeries")
        .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
          q.eq("userId", USER),
        )
        .unique(),
    );
    expect(series?.connectionId).toBeDefined();
    expect(series?.providerEventId).toBe("series-1");
    expect(series?.providerSeriesId).toBe("series-1");
    expect(series?.providerUpdatedMs).toBe(5);
    expect(series?.localCalendarId).toBeDefined();
  });
});
