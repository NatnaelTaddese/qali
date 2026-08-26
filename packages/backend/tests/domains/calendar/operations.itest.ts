import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

import { modules } from "../../testModules";

const USER = "user_dw";

async function preparePrimaryCalendar(t: TestConvex<typeof schema>) {
  await t.mutation(internal.domains.sync.engine.ensureSyncState, { userId: USER });
  const connectionId = await t.run(async (ctx) => {
    const connection = await ctx.db
      .query("calendarConnections")
      .withIndex("by_user_and_provider", (q) =>
        q.eq("userId", USER).eq("provider", "google"),
      )
      .unique();
    return connection!._id;
  });
  const attemptId = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
    connectionId,
  });
  await t.mutation(internal.domains.sync.engine.reconcileCalendars, {
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
  await t.mutation(internal.domains.sync.engine.recordSyncOutcome, {
    connectionId,
    attemptId: attemptId!,
    status: "idle",
    active: true,
  });
}

describe("calendar operations", () => {
  test("resolves a neutral event to its write target", async () => {
    const t = convexTest(schema, modules);
    const { eventId, connectionId, calendarId } = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      const calendarId = await ctx.db.insert("calendars", {
        userId: USER,
        connectionId,
        providerCalendarId: "primary",
        accessRole: "owner",
        primary: true,
        selected: true,
        isShared: false,
      });
      const eventId = await ctx.db.insert("events", {
        userId: USER,
        connectionId,
        localCalendarId: calendarId,
        providerEventId: "event-1",
        providerUpdatedMs: 9,
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
      });
      return { eventId, connectionId, calendarId };
    });

    const target = await t.mutation(internal.domains.calendar.mutations.resolveEventWriteTarget, {
      userId: USER,
      eventId,
    });
    expect(target).toMatchObject({
      connectionId,
      localCalendarId: calendarId,
      providerCalendarId: "primary",
      providerEventId: "event-1",
    });
  });

  test("claims and settles one authoritative calendar operation per assistant key", async () => {
    const t = convexTest(schema, modules);
    await preparePrimaryCalendar(t);
    const target = await t.mutation(internal.domains.calendar.mutations.resolveCreateTarget, {
      userId: USER,
    });
    const claim = await t.mutation(internal.domains.calendar.mutations.claimCalendarOperation, {
      userId: USER,
      ...target,
      idempotencyKey: "assistant-operation-1",
      kind: "create",
      requestFingerprint: "v1:create-one",
      attemptId: "attempt-1",
    });
    expect(claim).toMatchObject({ state: "claimed", reconcileOnly: false });
    expect(
      await t.mutation(internal.domains.calendar.mutations.settleCalendarOperation, {
        userId: USER,
        connectionId: target.connectionId,
        idempotencyKey: "assistant-operation-1",
        attemptId: "attempt-1",
        status: "succeeded",
        providerEventId: "provider-event-1",
      }),
    ).toBe(true);

    const replay = await t.mutation(internal.domains.calendar.mutations.claimCalendarOperation, {
      userId: USER,
      ...target,
      idempotencyKey: "assistant-operation-1",
      kind: "create",
      requestFingerprint: "v1:create-one",
      attemptId: "attempt-2",
    });
    expect(replay).toEqual({
      state: "succeeded",
      providerEventId: "provider-event-1",
    });
  });

  test("rejects idempotency-key reuse for a changed target or payload", async () => {
    const t = convexTest(schema, modules);
    await preparePrimaryCalendar(t);
    const target = await t.mutation(internal.domains.calendar.mutations.resolveCreateTarget, {
      userId: USER,
    });
    await t.mutation(internal.domains.calendar.mutations.claimCalendarOperation, {
      userId: USER,
      ...target,
      idempotencyKey: "bound-key",
      kind: "create",
      requestFingerprint: "v1:first-payload",
      attemptId: "first",
    });
    await t.run(async (ctx) => {
      const operation = await ctx.db.query("calendarOperations").unique();
      await ctx.db.patch(operation!._id, { leaseExpiresAt: 0 });
    });
    await expect(
      t.mutation(internal.domains.calendar.mutations.claimCalendarOperation, {
        userId: USER,
        ...target,
        idempotencyKey: "bound-key",
        kind: "create",
        requestFingerprint: "v1:changed-payload",
        attemptId: "second",
      }),
    ).rejects.toThrow(/another write/i);
    const otherCalendarId = await t.run((ctx) =>
      ctx.db.insert("calendars", {
        userId: USER,
        providerCalendarId: "other",
        connectionId: target.connectionId,
        accessRole: "owner",
        selected: true,
        isShared: false,
      }),
    );
    await expect(
      t.mutation(internal.domains.calendar.mutations.claimCalendarOperation, {
        userId: USER,
        connectionId: target.connectionId,
        localCalendarId: otherCalendarId,
        providerCalendarId: "other",
        idempotencyKey: "bound-key",
        kind: "create",
        requestFingerprint: "v1:first-payload",
        attemptId: "third",
      }),
    ).rejects.toThrow(/another write/i);
  });

  test("adopts the caller's local refs when the stored operation's were nulled by the cutover", async () => {
    const t = convexTest(schema, modules);
    await preparePrimaryCalendar(t);
    const target = await t.mutation(internal.domains.calendar.mutations.resolveCreateTarget, {
      userId: USER,
    });
    await t.mutation(internal.domains.calendar.mutations.claimCalendarOperation, {
      userId: USER,
      ...target,
      idempotencyKey: "cutover-key",
      kind: "create",
      requestFingerprint: "v1:payload",
      attemptId: "before-cutover",
    });
    // The provider cutover nulls local refs on every stored operation.
    await t.run(async (ctx) => {
      const operation = await ctx.db.query("calendarOperations").unique();
      await ctx.db.patch(operation!._id, {
        localCalendarId: undefined,
        targetEventId: undefined,
        leaseExpiresAt: 0,
      });
    });

    const retry = await t.mutation(internal.domains.calendar.mutations.claimCalendarOperation, {
      userId: USER,
      ...target,
      idempotencyKey: "cutover-key",
      kind: "create",
      requestFingerprint: "v1:payload",
      attemptId: "after-cutover",
    });
    expect(retry).toMatchObject({ state: "claimed" });
    const operation = await t.run((ctx) =>
      ctx.db.query("calendarOperations").unique(),
    );
    expect(operation).toMatchObject({
      localCalendarId: target.localCalendarId,
      providerCalendarId: target.providerCalendarId,
      attemptId: "after-cutover",
    });
  });

  test("creates a safe primary alias before the first calendar sync", async () => {
    const t = convexTest(schema, modules);
    const target = await t.mutation(internal.domains.calendar.mutations.resolveCreateTarget, {
      userId: "new-user",
    });
    expect(target.providerCalendarId).toBe("primary");
    const calendar = await t.run((ctx) => ctx.db.get(target.localCalendarId));
    expect(calendar).toMatchObject({
      primary: true,
      accessRole: "owner",
      selected: true,
      providerCalendarId: "primary",
    });
  });

  test("selects the local calendar when provider ids collide across connections", async () => {
    const t = convexTest(schema, modules);
    const {
      firstCalendarId,
      firstConnectionId,
      secondCalendarId,
      secondConnectionId,
    } = await t.run(async (ctx) => {
      const firstConnectionId = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      const secondConnectionId = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "microsoft",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      const firstCalendarId = await ctx.db.insert("calendars", {
        userId: USER,
        providerCalendarId: "shared-provider-id",
        connectionId: firstConnectionId,
        accessRole: "owner",
        primary: true,
        selected: true,
        isShared: false,
      });
      const secondCalendarId = await ctx.db.insert("calendars", {
        userId: USER,
        providerCalendarId: "shared-provider-id",
        connectionId: secondConnectionId,
        accessRole: "owner",
        selected: true,
        isShared: false,
      });
      return {
        firstCalendarId,
        firstConnectionId,
        secondCalendarId,
        secondConnectionId,
      };
    });

    const target = await t.mutation(internal.domains.calendar.mutations.resolveCreateTarget, {
      userId: USER,
      requestedCalendarId: secondCalendarId,
    });
    expect(target).toMatchObject({
      connectionId: secondConnectionId,
      localCalendarId: secondCalendarId,
      providerCalendarId: "shared-provider-id",
    });
    expect(
      await t.mutation(internal.domains.calendar.mutations.resolveCreateTarget, { userId: USER }),
    ).toMatchObject({
      connectionId: firstConnectionId,
      localCalendarId: firstCalendarId,
      providerCalendarId: "shared-provider-id",
    });
  });

  test("rejects a create target owned by another user", async () => {
    const t = convexTest(schema, modules);
    const foreignCalendarId = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: "foreign-user",
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert("calendars", {
        userId: "foreign-user",
        providerCalendarId: "primary",
        connectionId,
        accessRole: "owner",
        selected: true,
        isShared: false,
      });
    });

    await expect(
      t.mutation(internal.domains.calendar.mutations.resolveCreateTarget, {
        userId: USER,
        requestedCalendarId: foreignCalendarId,
      }),
    ).rejects.toThrow(/not found/i);
  });

});
