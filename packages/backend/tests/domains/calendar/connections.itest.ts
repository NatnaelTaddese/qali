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
      }),
    ).toMatchObject({ credentialRef: "account-1", provider: "google" });
    await t.run((ctx) => ctx.db.patch(connectionId, { status: "paused" }));
    expect(
      await t.query(internal.domains.calendar.queries.getCalendarConnectionForAdapter, {
        connectionId,
      }),
    ).toBeNull();
    await t.run((ctx) => ctx.db.patch(connectionId, { status: "error" }));
    expect(
      await t.query(internal.domains.calendar.queries.getCalendarConnectionForAdapter, {
        connectionId,
      }),
    ).toBeNull();
    await t.run((ctx) => ctx.db.delete(connectionId));
    expect(
      await t.query(internal.domains.calendar.queries.getCalendarConnectionForAdapter, {
        connectionId,
      }),
    ).toBeNull();
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
