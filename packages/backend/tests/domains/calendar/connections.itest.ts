import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../../convex/_generated/api";
import {
  setCalendarSummaryOverrideCore,
  setConnectionContactsCore,
  setConnectionStatusCore,
} from "../../../convex/domains/calendar/mutations";
import schema from "../../../convex/schema";

import { modules } from "../../testModules";

/** Smoke tests for the connection model: row shapes are insertable and
 * linkable, and adapter resolution respects connection status. */
describe("connection model", () => {
  test("adapter resolution exposes only an active connection", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await t.run((ctx) =>
      ctx.db.insert("calendarConnections", {
        userId: "owner",
        provider: "google",
        credentialRef: "account-1",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    expect(
      await t.query(internal.domains.calendar.queries.getCalendarConnectionForAdapter, {
        connectionId,
        userId: "owner",
      }),
    ).toMatchObject({ credentialRef: "account-1", provider: "google" });
    // A foreign caller never sees the connection, even while it is active.
    expect(
      await t.query(internal.domains.calendar.queries.getCalendarConnectionForAdapter, {
        connectionId,
        userId: "someone_else",
      }),
    ).toBeNull();
    await t.run((ctx) => ctx.db.patch(connectionId, { status: "paused" }));
    expect(
      await t.query(internal.domains.calendar.queries.getCalendarConnectionForAdapter, {
        connectionId,
        userId: "owner",
      }),
    ).toBeNull();
    await t.run((ctx) => ctx.db.patch(connectionId, { status: "error" }));
    expect(
      await t.query(internal.domains.calendar.queries.getCalendarConnectionForAdapter, {
        connectionId,
        userId: "owner",
      }),
    ).toBeNull();
    await t.run((ctx) => ctx.db.delete(connectionId));
    expect(
      await t.query(internal.domains.calendar.queries.getCalendarConnectionForAdapter, {
        connectionId,
        userId: "owner",
      }),
    ).toBeNull();
  });

  test("linked-account reconcile stamps the login grant and creates the rest once", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_link";
    // The pre-linking bootstrap connection: no credentialRef yet.
    const legacyId = await t.run((ctx) =>
      ctx.db.insert("calendarConnections", {
        userId,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const accounts = [
      { credentialRef: "google-sub-linked", createdAt: 2_000 },
      { credentialRef: "google-sub-login", createdAt: 1_000 },
    ];
    const first = await t.mutation(
      internal.domains.calendar.mutations.reconcileLinkedAccounts,
      { userId, accounts },
    );
    expect(first.created).toBe(1);
    // Both rows now know their grant but not their profile yet.
    expect(
      first.pendingIdentity.map((p) => p.credentialRef).sort(),
    ).toEqual(["google-sub-linked", "google-sub-login"]);
    // The oldest grant is the login one; it claims the legacy row.
    expect(
      (await t.run((ctx) => ctx.db.get(legacyId)))?.credentialRef,
    ).toBe("google-sub-login");
    const connections = await t.run((ctx) =>
      ctx.db
        .query("calendarConnections")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(connections).toHaveLength(2);
    const linked = connections.find(
      (row) => row.credentialRef === "google-sub-linked",
    );
    expect(linked).toMatchObject({ provider: "google", status: "active" });
    // The new connection starts with clean sync state.
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("connectionSyncState")
          .withIndex("by_connection", (q) =>
            q.eq("connectionId", linked!._id),
          )
          .unique(),
      ),
    ).toMatchObject({ status: "idle", nextSyncDueAt: 0 });
    // Re-running with the same grants creates nothing, but keeps reporting
    // the unstamped profiles until stampConnectionIdentity fills them.
    const second = await t.mutation(
      internal.domains.calendar.mutations.reconcileLinkedAccounts,
      { userId, accounts },
    );
    expect(second.created).toBe(0);
    expect(second.pendingIdentity).toHaveLength(2);
    await t.mutation(
      internal.domains.calendar.mutations.stampConnectionIdentity,
      {
        userId,
        connectionId: linked!._id,
        providerAccountId: "linked@example.com",
        providerAccountName: "Linked Account",
        providerAccountImageUrl: "https://example.com/a.png",
      },
    );
    expect(await t.run((ctx) => ctx.db.get(linked!._id))).toMatchObject({
      providerAccountId: "linked@example.com",
      providerAccountName: "Linked Account",
      providerAccountImageUrl: "https://example.com/a.png",
    });
    // A foreign stamp is refused, and a sync-stamped email is never replaced.
    await t.mutation(
      internal.domains.calendar.mutations.stampConnectionIdentity,
      {
        userId: "someone_else",
        connectionId: linked!._id,
        providerAccountName: "Hijacked",
      },
    );
    await t.mutation(
      internal.domains.calendar.mutations.stampConnectionIdentity,
      {
        userId,
        connectionId: linked!._id,
        providerAccountId: "other@example.com",
        providerAccountName: "Linked Renamed",
      },
    );
    expect(await t.run((ctx) => ctx.db.get(linked!._id))).toMatchObject({
      providerAccountId: "linked@example.com",
      providerAccountName: "Linked Renamed",
    });
    const third = await t.mutation(
      internal.domains.calendar.mutations.reconcileLinkedAccounts,
      { userId, accounts },
    );
    expect(third.pendingIdentity.map((p) => p.credentialRef)).toEqual([
      "google-sub-login",
    ]);
    expect(
      await t.run(async (ctx) =>
        (
          await ctx.db
            .query("calendarConnections")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .collect()
        ).length,
      ),
    ).toBe(2);
  });

  test("a connection links its sync-state and operation rows", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_conn";

    const ids = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId,
        provider: "google",
        credentialRef: "better-auth-account-1",
        status: "active",
        capabilities: { contacts: true, idempotentCreate: true },
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("connectionSyncState", {
        connectionId,
        userId,
        status: "idle",
        nextSyncDueAt: 0,
        syncIntervalMs: 900_000,
      });
      await ctx.db.insert("calendarOperations", {
        connectionId,
        userId,
        idempotencyKey: "op-1",
        kind: "create",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
      });
      return { connectionId };
    });

    await t.run(async (ctx) => {
      const connection = await ctx.db.get(ids.connectionId);
      expect(connection?.provider).toBe("google");
      expect(connection?.capabilities?.contacts).toBe(true);

      const syncState = await ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) =>
          q.eq("connectionId", ids.connectionId),
        )
        .unique();
      expect(syncState?.status).toBe("idle");

      const op = await ctx.db
        .query("calendarOperations")
        .withIndex("by_connection_and_key", (q) =>
          q.eq("connectionId", ids.connectionId).eq("idempotencyKey", "op-1"),
        )
        .unique();
      expect(op?.status).toBe("pending");
    });
  });

  test("neutral event identity includes the local calendar and cannot collide", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_dual";

    const { connectionId, firstCalendarId, secondCalendarId } = await t.run(
      async (ctx) => {
        const connectionId = await ctx.db.insert("calendarConnections", {
          userId,
          provider: "google",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        });
        const firstCalendarId = await ctx.db.insert("calendars", {
          userId,
          selected: true,
          connectionId,
          providerCalendarId: "first",
          isShared: false,
        });
        const secondCalendarId = await ctx.db.insert("calendars", {
          userId,
          selected: true,
          connectionId,
          providerCalendarId: "second",
          isShared: false,
        });
        return { connectionId, firstCalendarId, secondCalendarId };
      },
    );

    for (const [localCalendarId, startMs] of [
      [firstCalendarId, 1_000],
      [secondCalendarId, 3_000],
    ] as const) {
      await t.run((ctx) =>
        ctx.db.insert("events", {
          userId,
          startMs,
          endMs: startMs + 1_000,
          allDay: false,
          status: "confirmed",
          connectionId,
          localCalendarId,
          providerEventId: "same-provider-id",
          providerUpdatedMs: 1_000,
        }),
      );
    }

    const found = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_connection_and_localCalendarId_and_providerEventId", (q) =>
          q
            .eq("connectionId", connectionId)
            .eq("localCalendarId", secondCalendarId)
            .eq("providerEventId", "same-provider-id"),
        )
        .unique(),
    );
    expect(found?.localCalendarId).toBe(secondCalendarId);
    expect(found?.startMs).toBe(3_000);
  });

  test("pausing a connection removes it from the active sync set", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_pause";
    const connectionId = await t.run((ctx) =>
      ctx.db.insert("calendarConnections", {
        userId,
        provider: "google",
        status: "active",
        lastError: "quota exceeded",
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    await t.run((ctx) =>
      setConnectionStatusCore(ctx, userId, { connectionId, status: "paused" }),
    );
    expect(
      await t.query(internal.domains.sync.engine.listActiveConnections, {
        userId,
      }),
    ).toHaveLength(0);

    await t.run((ctx) =>
      setConnectionStatusCore(ctx, userId, { connectionId, status: "active" }),
    );
    const active = await t.query(
      internal.domains.sync.engine.listActiveConnections,
      { userId },
    );
    expect(active).toHaveLength(1);
    // Resuming is a fresh start — the stale provider error is cleared.
    expect(active[0].lastError).toBeUndefined();

    await expect(
      t.run((ctx) =>
        setConnectionStatusCore(ctx, "someone_else", {
          connectionId,
          status: "paused",
        }),
      ),
    ).rejects.toThrow("Connection not found");
  });

  test("toggling contacts flips the user flag and never touches capabilities", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_contacts";
    const connectionId = await t.run((ctx) =>
      ctx.db.insert("calendarConnections", {
        userId,
        provider: "google",
        status: "active",
        capabilities: { contacts: true, idempotentCreate: true },
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    await t.run((ctx) =>
      setConnectionContactsCore(ctx, userId, { connectionId, contacts: false }),
    );
    let row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row?.contactsSyncEnabled).toBe(false);
    // The adapter-owned mirror stays exactly as the adapter wrote it.
    expect(row?.capabilities).toEqual({ contacts: true, idempotentCreate: true });

    await t.run((ctx) =>
      setConnectionContactsCore(ctx, userId, { connectionId, contacts: true }),
    );
    row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row?.contactsSyncEnabled).toBe(true);

    await expect(
      t.run((ctx) =>
        setConnectionContactsCore(ctx, "someone_else", {
          connectionId,
          contacts: false,
        }),
      ),
    ).rejects.toThrow("Connection not found");
  });

  test("a summary override renames locally and clears back to the provider name", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_rename";
    const calendarId = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      return ctx.db.insert("calendars", {
        userId,
        connectionId,
        providerCalendarId: "primary",
        summary: "Provider Name",
        selected: true,
        isShared: false,
      });
    });

    await t.run((ctx) =>
      setCalendarSummaryOverrideCore(ctx, userId, {
        calendarId,
        summaryOverride: "  My Calendar  ",
      }),
    );
    expect(
      (await t.run((ctx) => ctx.db.get(calendarId)))?.summaryOverride,
    ).toBe("My Calendar");

    await t.run((ctx) =>
      setCalendarSummaryOverrideCore(ctx, userId, {
        calendarId,
        summaryOverride: "   ",
      }),
    );
    expect(
      (await t.run((ctx) => ctx.db.get(calendarId)))?.summaryOverride,
    ).toBeUndefined();

    await expect(
      t.run((ctx) =>
        setCalendarSummaryOverrideCore(ctx, "someone_else", {
          calendarId,
          summaryOverride: "Hijacked",
        }),
      ),
    ).rejects.toThrow("Calendar not found");
  });
});

describe("default create target with several accounts", () => {
  test("resolves to the oldest active connection's primary, unless one is requested", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_two_primaries";
    const seed = async (key: string, createdAt: number) =>
      await t.run(async (ctx) => {
        const connectionId = await ctx.db.insert("calendarConnections", {
          userId,
          provider: "google",
          credentialRef: `sub-${key}`,
          status: "active",
          createdAt,
          updatedAt: createdAt,
        });
        const calendarId = await ctx.db.insert("calendars", {
          userId,
          connectionId,
          providerCalendarId: `${key}@example.com`,
          primary: true,
          accessRole: "owner",
          selected: true,
          isShared: false,
        });
        return { connectionId, calendarId };
      });
    // Inserted linked-first so document order can't accidentally pass the test.
    const linked = await seed("linked", 2);
    const login = await seed("login", 1);

    const byDefault = await t.mutation(
      internal.domains.calendar.mutations.resolveCreateTarget,
      { userId },
    );
    expect(byDefault.connectionId).toEqual(login.connectionId);
    expect(byDefault.localCalendarId).toEqual(login.calendarId);

    const requested = await t.mutation(
      internal.domains.calendar.mutations.resolveCreateTarget,
      { userId, requestedCalendarId: linked.calendarId },
    );
    expect(requested.connectionId).toEqual(linked.connectionId);

    // Pausing the login connection hands the default to the linked account.
    await t.run((ctx) =>
      ctx.db.patch(login.connectionId, { status: "paused" }),
    );
    const afterPause = await t.mutation(
      internal.domains.calendar.mutations.resolveCreateTarget,
      { userId },
    );
    expect(afterPause.connectionId).toEqual(linked.connectionId);
  });
});
