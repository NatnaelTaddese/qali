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

describe("calendar dual-write", () => {
  test("upsertEvent stamps the neutral mirror and lazily creates the connection", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.calendar.upsertEvent, {
      userId: USER,
      event: googleEvent,
    });

    const { event, connectionCount, connectionId } = await t.run(async (ctx) => {
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
      };
    });

    // A connection was created on demand (backfill may have missed this user).
    expect(connectionCount).toBe(1);
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
  });
});

describe("sync engine dual-write", () => {
  test("reconcile + upsertEventsPage + setSyncToken stamp the neutral mirror", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.googleSync.reconcileCalendars, {
      userId: USER,
      calendars: [{ googleCalendarId: "primary", primary: true }],
    });
    await t.mutation(internal.googleSync.upsertEventsPage, {
      userId: USER,
      events: [googleEvent],
    });
    await t.mutation(internal.googleSync.setCalendarSyncToken, {
      userId: USER,
      googleCalendarId: "primary",
      syncToken: "tok-1",
    });

    await t.run(async (ctx) => {
      const cal = await ctx.db
        .query("calendars")
        .withIndex("by_user", (q) => q.eq("userId", USER))
        .unique();
      expect(cal?.connectionId).toBeDefined();
      expect(cal?.providerCalendarId).toBe("primary");
      expect(cal?.syncCursor).toBe("tok-1"); // mirrors syncToken

      const event = await ctx.db
        .query("events")
        .withIndex("by_user_and_start", (q) => q.eq("userId", USER))
        .unique();
      expect(event?.connectionId).toBe(cal?.connectionId);
      expect(event?.providerEventId).toBe("g-evt");
      expect(event?.providerUpdatedMs).toBe(777);
    });
  });
});
