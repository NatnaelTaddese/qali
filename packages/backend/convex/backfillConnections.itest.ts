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
    const localCalendarId = await t.run(async (ctx) => {
      const localCalendarId = await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: "primary",
        selected: true,
        connectionId,
        providerCalendarId: "primary",
      });
      await ctx.db.insert("events", {
        userId: USER,
        calendarId: "primary",
        googleEventId: "g-1",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 999,
        // A partially populated row must have every other mirror repaired.
        connectionId,
      });
      return localCalendarId;
    });

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
    expect(event?.localCalendarId).toBe(localCalendarId);

    // Restarting the same page is safe and keeps the exact same references.
    await t.mutation(internal.backfillConnections.backfillUserEvents, {
      userId: USER,
      connectionId,
      cursor: null,
    });
    expect(
      (await t.run((ctx) => ctx.db.get(event!._id)))?.localCalendarId,
    ).toBe(localCalendarId);
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
      await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: "primary",
        selected: true,
      });
      await ctx.db.insert("recurringSeries", {
        userId: USER,
        calendarId: "primary",
        googleEventId: "series-1",
        recurrence: ["RRULE:FREQ=WEEKLY"],
        sourceUpdatedMs: 42,
      });
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
      await ctx.db.insert(
        "bookings",
        booking(USER, {
          status: "pending",
          acceptOperationId: "op-failed",
          acceptMayHaveSucceeded: false,
        }),
      );
    });

    await t.mutation(internal.backfillConnections.backfillUserRows, {
      userId: USER,
      connectionId,
      phase: "recurringSeries",
      cursor: null,
    });

    await t.mutation(internal.backfillConnections.backfillUserTail, {
      userId: USER,
      connectionId,
    });

    const ops = await t.run((ctx) =>
      ctx.db.query("calendarOperations").collect(),
    );
    const byKey = new Map(ops.map((o) => [o.idempotencyKey, o.status]));
    expect(ops).toHaveLength(3);
    expect(byKey.get("op-acc")).toBe("succeeded");
    expect(byKey.get("op-amb")).toBe("ambiguous");
    expect(byKey.get("op-failed")).toBe("failed");
    expect(ops.every((op) => op.bookingId !== undefined)).toBe(true);
    const series = await t.run((ctx) =>
      ctx.db.query("recurringSeries").unique(),
    );
    expect(series).toMatchObject({
      connectionId,
      providerEventId: "series-1",
      providerSeriesId: "series-1",
      providerUpdatedMs: 42,
    });
    expect(series?.localCalendarId).toBeDefined();
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

    const eventReport = await t.query(
      internal.backfillConnections.verifyParity,
      { phase: "events", numItems: 1 },
    );
    expect(eventReport.scanned).toBe(1);
    expect(eventReport.mismatches).toBe(0);
    expect(eventReport.isDone).toBe(true);

    const calendarReport = await t.query(
      internal.backfillConnections.verifyParity,
      { phase: "calendars" },
    );
    expect(calendarReport.mismatches).toBe(0);
  });

  test("verification deterministically reports an exact field mismatch", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      const localCalendarId = await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: "primary",
        selected: true,
        connectionId,
        providerCalendarId: "primary",
      });
      await ctx.db.insert("events", {
        userId: USER,
        calendarId: "primary",
        googleEventId: "legacy",
        startMs: 1,
        endMs: 2,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 3,
        connectionId,
        localCalendarId,
        providerEventId: "wrong",
        providerUpdatedMs: 3,
      });
    });

    const report = await t.query(internal.backfillConnections.verifyParity, {
      phase: "events",
      numItems: 1,
    });
    expect(report).toMatchObject({ scanned: 1, mismatches: 1, isDone: true });
    expect(report.examples[0]?.reasons).toContain("providerEventId");
  });

  test("discovery includes a booking-page-only user and deduplicates a run", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("bookingPages", {
        userId: USER,
        slug: "only-page",
        displayName: "Page only",
        timeZone: "UTC",
        slotMinutes: 30,
        bufferMinutes: 0,
        minNoticeMinutes: 0,
        horizonDays: 30,
        rules: [],
        enabled: true,
      }),
    );
    const args = {
      phase: "bookingPages" as const,
      cursor: null,
      runId: "restartable-run",
    };
    await t.mutation(
      internal.backfillConnections.enqueueConnectionBackfill,
      args,
    );
    await t.mutation(
      internal.backfillConnections.enqueueConnectionBackfill,
      args,
    );
    const progress = await t.run((ctx) =>
      ctx.db.query("connectionBackfillUsers").collect(),
    );
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ userId: USER, runId: "restartable-run" });
  });

  test("backfills contact-scoped claims and gates legacy Other Contacts on a full sync", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("syncState", {
        userId: USER,
        status: "idle",
        otherContactsSyncToken: "unsafe-legacy-cursor",
      });
      for (const resourceName of ["people/one", "people/two"]) {
        await ctx.db.insert("contacts", {
          userId: USER,
          resourceName,
          emails: ["duplicate@example.com"],
          phones: [],
          syncGeneration: 4,
        });
      }
      await ctx.db.insert("people", {
        userId: USER,
        email: "legacy-other@example.com",
        sources: ["other"],
        otherSyncGeneration: 2,
        updatedAt: 1,
      });
    });
    await t.mutation(internal.backfillConnections.backfillUser, { userId: USER });
    const connectionId = (await connectionFor(t, USER))!;
    await t.mutation(internal.backfillConnections.backfillUserRows, {
      userId: USER,
      connectionId,
      phase: "contacts",
      cursor: null,
    });
    await t.mutation(internal.backfillConnections.backfillUserRows, {
      userId: USER,
      connectionId,
      phase: "people",
      cursor: null,
    });

    const claims = await t.run((ctx) =>
      ctx.db.query("personSourceClaims").collect(),
    );
    expect(claims.map((row) => row.providerContactId).sort()).toEqual([
      "people/one",
      "people/two",
    ]);
    expect(
      await t.query(internal.backfillConnections.verifyParity, {
        phase: "contacts",
      }),
    ).toMatchObject({ mismatches: 0 });
    const blocked = await t.query(internal.backfillConnections.verifyParity, {
      phase: "people",
    });
    expect(blocked.mismatches).toBe(1);
    expect(blocked.examples[0]?.reasons).toContain(
      "otherContactsFullSyncRequired",
    );
    const state = await t.run((ctx) =>
      ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
        .unique(),
    );
    expect(state?.otherContactsCursor).toBeUndefined();
    expect(state?.otherContactsBackfillRequired).toBe(true);

    const attemptId = await t.mutation(internal.calendarSync.claimSyncLease, {
      connectionId,
    });
    const generation = await t.mutation(
      internal.calendarSync.beginContactsFullResync,
      { connectionId, attemptId: attemptId!, feed: "other" },
    );
    await t.mutation(internal.calendarSync.upsertContactsPage, {
      connectionId,
      attemptId: attemptId!,
      feed: "other",
      syncGeneration: generation!,
      contacts: [
        {
          id: "other/exact",
          deleted: false,
          emails: ["legacy-other@example.com"],
          phones: [],
        },
      ],
    });
    await t.mutation(internal.calendarSync.sweepLegacyOtherPeopleBatch, {
      connectionId,
      attemptId: attemptId!,
      cursor: null,
    });
    await t.mutation(internal.calendarSync.commitContactsSync, {
      connectionId,
      attemptId: attemptId!,
      feed: "other",
      syncGeneration: generation!,
      syncCursor: "safe-cursor",
    });
    expect(
      await t.query(internal.backfillConnections.verifyParity, {
        phase: "people",
      }),
    ).toMatchObject({ mismatches: 0 });
  });

  test("removes historical contact emails without dropping a duplicate's claim", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("syncState", { userId: USER, status: "idle" });
      await ctx.db.insert("contacts", {
        userId: USER,
        resourceName: "people/changed",
        emails: ["new@example.com"],
        phones: [],
      });
      await ctx.db.insert("contacts", {
        userId: USER,
        resourceName: "people/duplicate",
        emails: ["shared@example.com"],
        phones: [],
      });
    });
    await t.mutation(internal.backfillConnections.backfillUser, { userId: USER });
    const connectionId = (await connectionFor(t, USER))!;
    await t.run(async (ctx) => {
      for (const email of [
        "old@example.com",
        "shared@example.com",
        "removed@example.com",
      ]) {
        await ctx.db.insert("people", {
          userId: USER,
          email,
          sources: ["connection"],
          updatedAt: 1,
        });
      }
      for (const [providerContactId, email] of [
        ["people/changed", "old@example.com"],
        ["people/changed", "shared@example.com"],
        ["people/removed", "removed@example.com"],
      ] as const) {
        await ctx.db.insert("personSourceClaims", {
          userId: USER,
          connectionId,
          source: "connection",
          providerContactId,
          email,
          updatedAt: 1,
        });
      }
    });

    await t.mutation(internal.backfillConnections.backfillUserRows, {
      userId: USER,
      connectionId,
      phase: "contacts",
      cursor: null,
    });
    await t.mutation(internal.backfillConnections.backfillUserRows, {
      userId: USER,
      connectionId,
      phase: "people",
      cursor: null,
    });

    const result = await t.run(async (ctx) => ({
      people: await ctx.db.query("people").collect(),
      claims: await ctx.db.query("personSourceClaims").collect(),
    }));
    expect(result.people.map((row) => row.email).sort()).toEqual([
      "new@example.com",
      "shared@example.com",
    ]);
    expect(
      result.claims
        .map((row) => `${row.providerContactId}:${row.email}`)
        .sort(),
    ).toEqual([
      "people/changed:new@example.com",
      "people/duplicate:shared@example.com",
    ]);
    expect(
      result.people.find((row) => row.email === "shared@example.com")?.sources,
    ).toContain("connection");
    expect(
      await t.query(internal.backfillConnections.verifyParity, {
        phase: "people",
      }),
    ).toMatchObject({ mismatches: 0 });
  });

  test("backfill never replaces a live neutral heartbeat with a legacy lease", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("syncState", {
        userId: USER,
        status: "syncing",
        contactsSyncToken: "legacy-cursor",
        syncAttemptId: "legacy-attempt",
        syncLeaseExpiresAt: Date.now() + 60_000,
      }),
    );
    await t.mutation(internal.backfillConnections.backfillUser, { userId: USER });
    const connectionId = (await connectionFor(t, USER))!;
    await t.run(async (ctx) => {
      const state = await ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
        .unique();
      await ctx.db.patch(state!._id, {
        status: "idle",
        syncAttemptId: undefined,
        syncLeaseExpiresAt: undefined,
        contactsCursor: "neutral-cursor",
      });
    });
    const attemptId = await t.mutation(internal.calendarSync.claimSyncLease, {
      connectionId,
    });
    await t.mutation(internal.calendarSync.heartbeatSyncLease, {
      connectionId,
      attemptId: attemptId!,
    });
    const before = await t.run((ctx) =>
      ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
        .unique(),
    );
    await t.mutation(internal.backfillConnections.backfillUser, { userId: USER });
    const after = await t.run((ctx) =>
      ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
        .unique(),
    );
    expect(after?.syncAttemptId).toBe(attemptId);
    expect(after?.syncLeaseExpiresAt).toBe(before?.syncLeaseExpiresAt);
    expect(after?.contactsCursor).toBe("neutral-cursor");
  });
});
