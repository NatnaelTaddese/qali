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
    await t.mutation(internal.googleSync.reconcileCalendars, {
      userId: USER,
      calendars: [{ googleCalendarId: "primary", primary: true }],
    });
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

describe("sync engine dual-write", () => {
  test("reconcile + upsertEventsPage + setSyncToken stamp the neutral mirror", async () => {
    const t = convexTest(schema, modules);
    // Exercise the existing-calendar branch, not only discovery inserts.
    await t.run(async (ctx) => {
      await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: "primary",
        selected: true,
      });
      await ctx.db.insert("bookingPages", {
        userId: USER,
        slug: "dual-write",
        displayName: "Dual Writer",
        timeZone: "UTC",
        slotMinutes: 30,
        bufferMinutes: 0,
        minNoticeMinutes: 0,
        horizonDays: 30,
        rules: [],
        enabled: true,
      });
    });

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
      expect(event?.localCalendarId).toBe(cal?._id);
      expect(event?.providerEventId).toBe("g-evt");
      expect(event?.providerUpdatedMs).toBe(777);

      const bookingPage = await ctx.db
        .query("bookingPages")
        .withIndex("by_user", (q) => q.eq("userId", USER))
        .unique();
      expect(bookingPage).toMatchObject({
        targetConnectionId: cal?.connectionId,
        targetCalendarId: cal?._id,
      });
    });
  });

  test("sync-state transitions and contacts mirror onto the connection", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.googleSync.ensureSyncState, { userId: USER });
    const attemptId = await t.mutation(internal.googleSync.claimSyncLease, {
      userId: USER,
    });
    expect(attemptId).toEqual(expect.any(String));
    await t.mutation(internal.googleSync.setContactsSync, {
      userId: USER,
      syncToken: "contacts-cursor",
      syncGeneration: 4,
    });
    await t.mutation(internal.googleSync.upsertContactsPage, {
      userId: USER,
      contacts: [
        {
          resourceName: "people/1",
          deleted: false,
          emails: ["person@example.com"],
          phones: [],
          googleEtag: "etag-1",
        },
      ],
    });
    await t.mutation(internal.googleSync.recordSyncOutcome, {
      userId: USER,
      attemptId: attemptId!,
      status: "idle",
      active: true,
    });

    await t.run(async (ctx) => {
      const connection = await ctx.db
        .query("calendarConnections")
        .withIndex("by_user_and_provider", (q) =>
          q.eq("userId", USER).eq("provider", "google"),
        )
        .unique();
      const state = await ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) =>
          q.eq("connectionId", connection!._id),
        )
        .unique();
      expect(state).toMatchObject({
        status: "idle",
        contactsCursor: "contacts-cursor",
        contactsGeneration: 4,
      });
      expect(state?.contactsLastSyncedAt).toEqual(expect.any(Number));
      expect(state?.syncAttemptId).toBeUndefined();
      expect(state?.syncLeaseExpiresAt).toBeUndefined();

      const contact = await ctx.db
        .query("contacts")
        .withIndex("by_user", (q) => q.eq("userId", USER))
        .unique();
      expect(contact).toMatchObject({
        connectionId: connection?._id,
        providerContactId: "people/1",
        providerVersion: "etag-1",
      });
    });
  });

  test("shared calendar and event writers stamp provider-scoped identity", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.googleSync.claimSharedCalendarSync, {
      googleCalendarId: "holidays",
      refreshIntervalMs: 1,
    });
    await t.mutation(internal.googleSync.upsertSharedEventsPage, {
      events: [{ ...googleEvent, calendarId: "holidays" }],
    });
    await t.mutation(internal.googleSync.setSharedCalendarSynced, {
      googleCalendarId: "holidays",
      syncToken: "shared-cursor",
    });

    await t.run(async (ctx) => {
      const calendar = await ctx.db.query("sharedCalendars").unique();
      expect(calendar).toMatchObject({
        provider: "google",
        providerCalendarId: "holidays",
        syncCursor: "shared-cursor",
      });
      const event = await ctx.db.query("sharedEvents").unique();
      expect(event).toMatchObject({
        provider: "google",
        providerCalendarId: "holidays",
        providerEventId: "g-evt",
        providerUpdatedMs: 777,
      });
    });
  });
});
