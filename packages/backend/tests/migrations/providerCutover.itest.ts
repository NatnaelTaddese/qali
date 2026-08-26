import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";

import { modules } from "../testModules";

/** C2 NOTE: deleted together with migrations/providerCutover.ts at the final
 * schema — both reference transitional-only columns and tables. */

const MIN_MS = 60 * 1000;

// The wipe order the migration walks; the driver below feeds it one table at
// a time so the chain stays deterministic under fake timers.
const WIPE_TABLES = [
  "events",
  "recurringSeries",
  "calendars",
  "sharedCalendars",
  "sharedEvents",
  "contacts",
  "people",
  "personSourceClaims",
  "otherContactSources",
  "connectionBackfillUsers",
  "syncState",
] as const;

/** Drives every phase directly instead of letting the scheduler chain run:
 * fake timers hold the runAfter(0) hand-offs pending, which keeps the
 * scheduled queue inspectable and keeps the fan-out's syncUser actions from
 * actually syncing. `drainEventAttendees` is skipped — its orphan off-schema
 * table cannot exist under convex-test's schema-validated database. */
async function runCutover(t: ReturnType<typeof convexTest>) {
  await t.mutation(
    internal.migrations.providerCutover.expireAssistantActions,
    {},
  );
  await t.mutation(internal.migrations.providerCutover.clearBookingTargets, {});
  await t.mutation(
    internal.migrations.providerCutover.clearBookingPageTargets,
    {},
  );
  await t.mutation(
    internal.migrations.providerCutover.clearCalendarOperationRefs,
    {},
  );
  await t.mutation(
    internal.migrations.providerCutover.resetConnectionSyncState,
    {},
  );
  for (const table of WIPE_TABLES) {
    await t.mutation(internal.migrations.providerCutover.wipeDerivedTables, {
      table,
    });
  }
  return await t.mutation(internal.migrations.providerCutover.fanOutResync, {});
}

/** Two users, each with a connection; u1 additionally carries one row in every
 * table the cutover touches — wiped, nulled, and preserved alike. */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const connections = {} as Record<"u1" | "u2", Id<"calendarConnections">>;
    for (const userId of ["u1", "u2"] as const) {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      connections[userId] = connectionId;
      await ctx.db.insert("connectionSyncState", {
        connectionId,
        userId,
        status: "error",
        lastError: "boom",
        contactsCursor: "contacts-cursor",
        otherContactsCursor: "other-cursor",
        contactsLastSyncedAt: now,
        otherContactsLastSyncedAt: now,
        contactsGeneration: 3,
        otherContactsGeneration: 4,
        contactsGenerationAttemptId: "cg",
        otherContactsGenerationAttemptId: "og",
        otherContactsBackfillRequired: true,
        nextSyncDueAt: now + 60 * MIN_MS,
        syncIntervalMs: 60 * MIN_MS,
      });
      await ctx.db.insert("userSyncState", {
        userId,
        engagementDirty: false,
        engagementAttemptId: "ea",
        engagementLeaseExpiresAt: now + 60 * MIN_MS,
        updatedAt: 1,
      });
      await ctx.db.insert("syncState", { userId, status: "idle" });
    }
    const connectionId = connections.u1;
    const localCalendarId = await ctx.db.insert("calendars", {
      userId: "u1",
      connectionId,
      providerCalendarId: "cal-1",
      selected: true,
      isShared: false,
    });
    const eventId = await ctx.db.insert("events", {
      userId: "u1",
      connectionId,
      localCalendarId,
      providerEventId: "evt-1",
      providerUpdatedMs: 1,
      startMs: now,
      endMs: now + MIN_MS,
      allDay: false,
      status: "confirmed",
    });
    await ctx.db.insert("recurringSeries", {
      userId: "u1",
      connectionId,
      localCalendarId,
      providerEventId: "evt-1",
      providerUpdatedMs: 1,
      recurrence: ["RRULE:FREQ=DAILY"],
    });
    await ctx.db.insert("sharedCalendars", {
      provider: "google",
      providerCalendarId: "holidays",
    });
    await ctx.db.insert("sharedEvents", {
      provider: "google",
      providerCalendarId: "holidays",
      providerEventId: "hol-1",
      providerUpdatedMs: 1,
      startMs: now,
      endMs: now + MIN_MS,
      allDay: true,
      status: "confirmed",
    });
    await ctx.db.insert("contacts", {
      userId: "u1",
      connectionId,
      providerContactId: "people/1",
      emails: ["a@example.com"],
      phones: [],
    });
    await ctx.db.insert("people", {
      userId: "u1",
      email: "a@example.com",
      sources: ["connection"],
      updatedAt: 1,
    });
    await ctx.db.insert("personSourceClaims", {
      userId: "u1",
      connectionId,
      source: "connection",
      providerContactId: "people/1",
      email: "a@example.com",
      updatedAt: 1,
    });
    await ctx.db.insert("otherContactSources", {
      userId: "u1",
      connectionId,
      providerContactId: "other/1",
      emails: ["b@example.com"],
    });
    await ctx.db.insert("connectionBackfillUsers", {
      userId: "u1",
      runId: "run",
      updatedAt: 1,
    });
    const bookingId = await ctx.db.insert("bookings", {
      hostUserId: "u1",
      startMs: now,
      endMs: now + MIN_MS,
      timeZone: "UTC",
      requesterName: "R",
      requesterEmail: "r@example.com",
      status: "accepted",
      token: "tok-1",
      createdAt: 1,
      decidedAt: 2,
      connectionId,
      providerEventId: "evt-1",
      targetConnectionId: connectionId,
      targetCalendarId: localCalendarId,
      acceptOperationId: "op-1",
      googleEventId: "evt-1",
      calendarId: "cal-1",
      acceptAttemptId: "att-1",
      acceptLeaseExpiresAt: now + MIN_MS,
      acceptMayHaveSucceeded: true,
    });
    const bookingPageId = await ctx.db.insert("bookingPages", {
      userId: "u1",
      slug: "u1",
      displayName: "U One",
      timeZone: "UTC",
      slotMinutes: 30,
      bufferMinutes: 0,
      minNoticeMinutes: 0,
      horizonDays: 14,
      rules: [],
      enabled: true,
      targetConnectionId: connectionId,
      targetCalendarId: localCalendarId,
    });
    const operationId = await ctx.db.insert("calendarOperations", {
      connectionId,
      userId: "u1",
      idempotencyKey: "op-1",
      kind: "create",
      status: "succeeded",
      bookingId,
      localCalendarId,
      providerCalendarId: "cal-1",
      targetEventId: eventId,
      targetProviderEventId: "evt-1",
      providerEventId: "evt-1",
      createdAt: 1,
      updatedAt: 1,
    });
    const threadId = await ctx.db.insert("assistantThreads", {
      userId: "u1",
      title: "t",
      createdAt: 1,
      lastMessageAt: 1,
    });
    const action = (status: "pending" | "applying" | "applied") =>
      ctx.db.insert("assistantActions", {
        threadId,
        userId: "u1",
        toolCallId: `call-${status}`,
        tool: "createEvent",
        input: "{}",
        preview: "p",
        status,
        createdAt: 1,
      });
    const actions = {
      pending: await action("pending"),
      applying: await action("applying"),
      applied: await action("applied"),
    };
    await ctx.db.insert("availabilityOverrides", {
      userId: "u1",
      dateKey: "2026-01-01",
      intervals: [],
    });
    return {
      connections,
      bookingId,
      bookingPageId,
      operationId,
      actions,
    };
  });
}

describe("providerCutover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("nulls hazard references pairwise and expires in-flight assistant actions", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await runCutover(t);

    await t.run(async (ctx) => {
      const booking = await ctx.db.get(ids.bookingId);
      expect(booking).toMatchObject({
        status: "accepted",
        decidedAt: 2,
        acceptOperationId: "op-1",
        connectionId: ids.connections.u1,
        providerEventId: "evt-1",
      });
      expect(booking?.googleEventId).toBeUndefined();
      expect(booking?.calendarId).toBeUndefined();
      expect(booking?.targetConnectionId).toBeUndefined();
      expect(booking?.targetCalendarId).toBeUndefined();
      expect(booking?.acceptAttemptId).toBeUndefined();
      expect(booking?.acceptLeaseExpiresAt).toBeUndefined();
      expect(booking?.acceptMayHaveSucceeded).toBeUndefined();

      const page = await ctx.db.get(ids.bookingPageId);
      expect(page?.targetConnectionId).toBeUndefined();
      expect(page?.targetCalendarId).toBeUndefined();

      const operation = await ctx.db.get(ids.operationId);
      expect(operation?.localCalendarId).toBeUndefined();
      expect(operation?.targetEventId).toBeUndefined();
      // Provider strings carry identity across the wipe.
      expect(operation).toMatchObject({
        providerCalendarId: "cal-1",
        providerEventId: "evt-1",
        idempotencyKey: "op-1",
        status: "succeeded",
      });

      const pending = await ctx.db.get(ids.actions.pending);
      const applying = await ctx.db.get(ids.actions.applying);
      const applied = await ctx.db.get(ids.actions.applied);
      for (const expired of [pending, applying]) {
        expect(expired?.status).toBe("failed");
        expect(expired?.resultSummary).toBe(
          "Superseded by the provider-model cutover; please re-ask.",
        );
        expect(expired?.decidedAt).toBeDefined();
      }
      expect(applied?.status).toBe("applied");
      expect(applied?.resultSummary).toBeUndefined();
    });
  });

  test("wipes every derived table and preserves the operational ones", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await runCutover(t);

    await t.run(async (ctx) => {
      for (const table of WIPE_TABLES) {
        expect(await ctx.db.query(table).collect()).toHaveLength(0);
      }
      expect(await ctx.db.query("calendarConnections").collect()).toHaveLength(2);
      expect(await ctx.db.query("connectionSyncState").collect()).toHaveLength(2);
      expect(await ctx.db.query("userSyncState").collect()).toHaveLength(2);
      expect(await ctx.db.query("bookings").collect()).toHaveLength(1);
      expect(await ctx.db.query("bookingPages").collect()).toHaveLength(1);
      expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(1);
      expect(await ctx.db.query("assistantActions").collect()).toHaveLength(3);
      expect(await ctx.db.query("availabilityOverrides").collect()).toHaveLength(
        1,
      );
    });
  });

  test("the sentinel lease blocks claimSyncLease until the fan-out releases it", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await t.mutation(
      internal.migrations.providerCutover.resetConnectionSyncState,
      {},
    );
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("connectionSyncState").collect()) {
        expect(row.syncAttemptId).toBe("cutover");
        expect(row.syncLeaseExpiresAt).toBeGreaterThan(Date.now());
        expect(row.status).toBe("idle");
        expect(row.nextSyncDueAt).toBeLessThanOrEqual(Date.now());
        expect(row.contactsCursor).toBeUndefined();
        expect(row.otherContactsCursor).toBeUndefined();
        expect(row.contactsGeneration).toBeUndefined();
        expect(row.otherContactsGeneration).toBeUndefined();
        expect(row.otherContactsBackfillRequired).toBeUndefined();
        expect(row.lastError).toBeUndefined();
        expect(row.syncIntervalMs).toBeUndefined();
      }
      for (const row of await ctx.db.query("userSyncState").collect()) {
        expect(row.engagementDirty).toBe(true);
        expect(row.engagementAttemptId).toBeUndefined();
        expect(row.engagementLeaseExpiresAt).toBeUndefined();
      }
    });
    // Mid-wipe a cron tick or an open tab's syncNow must not win a lease.
    expect(
      await t.mutation(internal.domains.sync.engine.claimSyncLease, {
        connectionId: ids.connections.u1,
      }),
    ).toBeNull();

    const result = await t.mutation(
      internal.migrations.providerCutover.fanOutResync,
      {},
    );
    expect(result).toEqual({ done: true });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("connectionSyncState").collect()) {
        expect(row.syncAttemptId).toBeUndefined();
        expect(row.syncLeaseExpiresAt).toBeUndefined();
      }
    });
    expect(
      await t.mutation(internal.domains.sync.engine.claimSyncLease, {
        connectionId: ids.connections.u1,
      }),
    ).toBeTypeOf("string");
  });

  test("the fan-out schedules one syncUser per user", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await runCutover(t);

    const jobs = await t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
    );
    const syncs = jobs.filter(
      (job) =>
        job.name.includes("domains/sync/engine") &&
        job.name.endsWith(":syncUser"),
    );
    expect(syncs.map((job) => job.args)).toEqual(
      expect.arrayContaining([[{ userId: "u1" }], [{ userId: "u2" }]]),
    );
    expect(syncs).toHaveLength(2);
  });

  test("re-running every phase leaves the terminal state unchanged", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await runCutover(t);
    const result = await runCutover(t);
    expect(result).toEqual({ done: true });

    await t.run(async (ctx) => {
      for (const table of WIPE_TABLES) {
        expect(await ctx.db.query(table).collect()).toHaveLength(0);
      }
      const booking = await ctx.db.get(ids.bookingId);
      expect(booking).toMatchObject({
        status: "accepted",
        acceptOperationId: "op-1",
        providerEventId: "evt-1",
      });
      expect(booking?.targetCalendarId).toBeUndefined();
      // Already-expired proposals are skipped, not re-stamped.
      const pending = await ctx.db.get(ids.actions.pending);
      expect(pending?.status).toBe("failed");
      const applied = await ctx.db.get(ids.actions.applied);
      expect(applied?.status).toBe("applied");
      for (const row of await ctx.db.query("connectionSyncState").collect()) {
        expect(row.syncAttemptId).toBeUndefined();
      }
    });
  });
});
