/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/**
 * The connection tables are deployed empty and queried by nothing yet, so there
 * are no functions to exercise. This smoke test just proves the intended row
 * shapes are insertable and linkable — a record of what the Stage 5 backfill
 * will write, and a guard against a schema drift that would break it.
 */
describe("connection model expand", () => {
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
});
