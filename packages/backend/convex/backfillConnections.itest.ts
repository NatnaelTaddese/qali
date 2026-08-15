/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const USER = "user_bf";

async function connectionFor(
  t: ReturnType<typeof convexTest>,
  userId: string,
): Promise<Id<"calendarConnections"> | null> {
  return t.run(async (ctx) => {
    const c = await ctx.db
      .query("calendarConnections")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", userId).eq("provider", "google"),
      )
      .first();
    return c?._id ?? null;
  });
}

describe("connection backfill", () => {
  test("backfillUser creates one connection and copies sync state + calendars", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("syncState", {
        userId: USER,
        status: "idle",
        contactsSyncToken: "ct-1",
        contactsSyncGeneration: 3,
        nextSyncDueAt: 111,
        syncIntervalMs: 900_000,
      });
      await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: "primary",
        selected: true,
        syncToken: "cal-cursor-1",
      });
    });

    await t.mutation(internal.backfillConnections.backfillUser, { userId: USER });

    const connectionId = await connectionFor(t, USER);
    expect(connectionId).not.toBeNull();

    await t.run(async (ctx) => {
      const state = await ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", connectionId!))
        .unique();
      expect(state?.contactsCursor).toBe("ct-1");
      expect(state?.contactsGeneration).toBe(3);
      expect(state?.nextSyncDueAt).toBe(111);

      const cal = await ctx.db
        .query("calendars")
        .withIndex("by_user", (q) => q.eq("userId", USER))
        .unique();
      expect(cal?.connectionId).toBe(connectionId);
      expect(cal?.providerCalendarId).toBe("primary");
      expect(cal?.syncCursor).toBe("cal-cursor-1");
    });
  });

  test("is idempotent — a second run makes no second connection or sync-state row", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("syncState", { userId: USER, status: "idle" }),
    );

    await t.mutation(internal.backfillConnections.backfillUser, { userId: USER });
    await t.mutation(internal.backfillConnections.backfillUser, { userId: USER });

    const counts = await t.run(async (ctx) => ({
      connections: (
        await ctx.db
          .query("calendarConnections")
          .withIndex("by_user", (q) => q.eq("userId", USER))
          .collect()
      ).length,
      states: (await ctx.db.query("connectionSyncState").collect()).length,
    }));
    expect(counts).toEqual({ connections: 1, states: 1 });
  });

  test("backfillUserEvents mirrors the google id/updated onto events", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await t.run((ctx) =>
      ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("events", {
        userId: USER,
        calendarId: "primary",
        googleEventId: "g-1",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 999,
      }),
    );

    await t.mutation(internal.backfillConnections.backfillUserEvents, {
      userId: USER,
      connectionId,
      cursor: null,
    });

    const event = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_user_and_start", (q) => q.eq("userId", USER))
        .unique(),
    );
    expect(event?.connectionId).toBe(connectionId);
    expect(event?.providerEventId).toBe("g-1");
    expect(event?.providerUpdatedMs).toBe(999);
  });

  test("backfillUserTail seeds the ledger: accepted -> succeeded, uncertain -> ambiguous", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await t.run((ctx) =>
      ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const booking = (
      hostUserId: string,
      overrides: Record<string, unknown>,
    ) => ({
      hostUserId,
      startMs: 1_000,
      endMs: 2_000,
      timeZone: "UTC",
      requesterName: "R",
      requesterEmail: "r@x.com",
      token: `tok-${Math.random()}`,
      createdAt: 1,
      ...overrides,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "bookings",
        booking(USER, {
          status: "accepted",
          googleEventId: "g-acc",
          acceptOperationId: "op-acc",
        }),
      );
      await ctx.db.insert(
        "bookings",
        booking(USER, {
          status: "pending",
          acceptOperationId: "op-amb",
          acceptMayHaveSucceeded: true,
        }),
      );
      // A booking that never ran an accept produces no ledger row.
      await ctx.db.insert("bookings", booking(USER, { status: "pending" }));
    });

    await t.mutation(internal.backfillConnections.backfillUserTail, {
      userId: USER,
      connectionId,
    });

    const ops = await t.run((ctx) =>
      ctx.db.query("calendarOperations").collect(),
    );
    const byKey = new Map(ops.map((o) => [o.idempotencyKey, o.status]));
    expect(ops).toHaveLength(2);
    expect(byKey.get("op-acc")).toBe("succeeded");
    expect(byKey.get("op-amb")).toBe("ambiguous");
  });

  test("verifyParity reports full parity after a backfill", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("syncState", { userId: USER, status: "idle" });
      await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: "primary",
        selected: true,
      });
      await ctx.db.insert("events", {
        userId: USER,
        calendarId: "primary",
        googleEventId: "g-1",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 1,
      });
    });

    // backfillUser sets up the connection + calendars and schedules the event
    // pass; drive that pass directly rather than depend on the scheduler.
    await t.mutation(internal.backfillConnections.backfillUser, { userId: USER });
    const connectionId = (await connectionFor(t, USER))!;
    await t.mutation(internal.backfillConnections.backfillUserEvents, {
      userId: USER,
      connectionId,
      cursor: null,
    });

    const report = await t.query(internal.backfillConnections.verifyParity, {});
    expect(report.usersMatch).toBe(true);
    expect(report.connections).toBe(1);
    expect(report.events.lackingConnectionId).toBe(0);
    expect(report.events.sampleCapped).toBe(false); // whole table covered
    expect(report.calendars.lackingConnectionId).toBe(0);
  });
});
