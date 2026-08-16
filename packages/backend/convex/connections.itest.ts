/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";
import { calendarTables } from "./domains/calendar/tables";

const modules = import.meta.glob("./**/*.ts");

/**
 * The connection tables are deployed empty and queried by nothing yet, so there
 * are no functions to exercise. This smoke test just proves the intended row
 * shapes are insertable and linkable — a record of what the Stage 5 backfill
 * will write, and a guard against a schema drift that would break it.
 */
describe("connection model expand", () => {
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
      await t.query(internal.calendar.getCalendarConnectionForAdapter, {
        connectionId,
      }),
    ).toMatchObject({ credentialRef: "account-1", provider: "google" });
    await t.run((ctx) => ctx.db.patch(connectionId, { status: "paused" }));
    expect(
      await t.query(internal.calendar.getCalendarConnectionForAdapter, {
        connectionId,
      }),
    ).toBeNull();
    await t.run((ctx) => ctx.db.patch(connectionId, { status: "error" }));
    expect(
      await t.query(internal.calendar.getCalendarConnectionForAdapter, {
        connectionId,
      }),
    ).toBeNull();
    await t.run((ctx) => ctx.db.delete(connectionId));
    expect(
      await t.query(internal.calendar.getCalendarConnectionForAdapter, {
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
          googleCalendarId: "first",
          selected: true,
          connectionId,
          providerCalendarId: "first",
        });
        const secondCalendarId = await ctx.db.insert("calendars", {
          userId,
          googleCalendarId: "second",
          selected: true,
          connectionId,
          providerCalendarId: "second",
        });
        return { connectionId, firstCalendarId, secondCalendarId };
      },
    );

    for (const [calendarId, localCalendarId, startMs] of [
      ["first", firstCalendarId, 1_000],
      ["second", secondCalendarId, 3_000],
    ] as const) {
      await t.run((ctx) =>
        ctx.db.insert("events", {
          userId,
          calendarId,
          googleEventId: "same-provider-id",
          startMs,
          endMs: startMs + 1_000,
          allDay: false,
          status: "confirmed",
          googleUpdatedMs: 1_000,
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
        // The production index is staged during expand, so convex-test cannot
        // query it yet. Apply the same complete key and assert its declaration.
        .filter((q) =>
          q.and(
            q.eq(q.field("connectionId"), connectionId),
            q.eq(q.field("localCalendarId"), secondCalendarId),
            q.eq(q.field("providerEventId"), "same-provider-id"),
          ),
        )
        .unique(),
    );
    expect(found?.calendarId).toBe("second");
    expect(found?.localCalendarId).toBe(secondCalendarId);
    const indexes = (
      calendarTables.events as unknown as {
        stagedDbIndexes: { indexDescriptor: string; fields: string[] }[];
      }
    ).stagedDbIndexes;
    expect(indexes).toContainEqual({
      indexDescriptor: "by_connection_and_localCalendarId_and_providerEventId",
      fields: ["connectionId", "localCalendarId", "providerEventId"],
    });
  });
});
