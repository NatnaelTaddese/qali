/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../_generated/api";
import schema from "../schema";

import { modules } from "../../testModules";

describe("purgeUserData", () => {
  test("erases every per-user row and the waitlist entry, sparing other users", async () => {
    const t = convexTest(schema, modules);
    const userId = "victim";
    const email = "victim@example.com";
    await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("connectionSyncState", {
        connectionId,
        userId,
        status: "idle",
      });
      await ctx.db.insert("userSyncState", {
        userId,
        engagementDirty: false,
        updatedAt: 1,
      });
      await ctx.db.insert("personSourceClaims", {
        userId,
        connectionId,
        email,
        source: "other",
        updatedAt: 1,
      });
      await ctx.db.insert("otherContactSources", {
        userId,
        connectionId,
        providerContactId: "other/1",
        emails: [email],
      });
      await ctx.db.insert("calendarOperations", {
        connectionId,
        userId,
        idempotencyKey: "op",
        kind: "create",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("connectionBackfillUsers", {
        userId,
        runId: "run",
        updatedAt: 1,
      });
      await ctx.db.insert("events", {
        userId,
        calendarId: "c",
        googleEventId: "e",
        startMs: 1,
        endMs: 2,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 1,
      });
      await ctx.db.insert("calendars", {
        userId,
        googleCalendarId: "c",
        selected: true,
      });
      await ctx.db.insert("contacts", {
        userId,
        resourceName: "r",
        emails: [email],
        phones: [],
      });
      await ctx.db.insert("people", {
        userId,
        email,
        sources: ["connection"],
        updatedAt: 1,
      });
      await ctx.db.insert("bookings", {
        hostUserId: userId,
        startMs: 1,
        endMs: 2,
        status: "pending",
        requesterEmail: email,
        requesterName: "V",
        timeZone: "UTC",
        token: "tok",
        createdAt: 1,
      });
      await ctx.db.insert("waitlist", { email, createdAt: 1 });
      // Another user's rows must survive the purge.
      await ctx.db.insert("calendars", {
        userId: "bystander",
        googleCalendarId: "c2",
        selected: true,
      });
      await ctx.db.insert("waitlist", {
        email: "keep@example.com",
        createdAt: 1,
      });
    });

    const res = await t.mutation(internal.jobs.maintenance.purgeUserData, {
      userId,
      email,
    });
    expect(res.done).toBe(true);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("events").collect()).toHaveLength(0);
      expect(await ctx.db.query("contacts").collect()).toHaveLength(0);
      expect(await ctx.db.query("people").collect()).toHaveLength(0);
      expect(await ctx.db.query("bookings").collect()).toHaveLength(0);
      expect(await ctx.db.query("calendarConnections").collect()).toHaveLength(0);
      expect(await ctx.db.query("connectionSyncState").collect()).toHaveLength(0);
      expect(await ctx.db.query("userSyncState").collect()).toHaveLength(0);
      expect(await ctx.db.query("personSourceClaims").collect()).toHaveLength(0);
      expect(await ctx.db.query("otherContactSources").collect()).toHaveLength(0);
      expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(0);
      expect(await ctx.db.query("connectionBackfillUsers").collect()).toHaveLength(
        0,
      );
      const calendars = await ctx.db.query("calendars").collect();
      expect(calendars.map((c) => c.userId)).toEqual(["bystander"]);
      const waitlist = await ctx.db.query("waitlist").collect();
      expect(waitlist.map((w) => w.email)).toEqual(["keep@example.com"]);
    });
  });
});

describe("calendar operation retention", () => {
  test("prunes only aged terminal rows and preserves authority records", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: "retention-user",
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
      const insert = (
        key: string,
        status: "pending" | "ambiguous" | "succeeded" | "failed",
        updatedAt = old,
      ) =>
        ctx.db.insert("calendarOperations", {
          connectionId,
          userId: "retention-user",
          idempotencyKey: key,
          kind: "create",
          status,
          createdAt: old,
          updatedAt,
        });
      return {
        succeeded: await insert("succeeded", "succeeded"),
        failed: await insert("failed", "failed"),
        pending: await insert("pending", "pending"),
        ambiguous: await insert("ambiguous", "ambiguous"),
        recent: await insert("recent", "succeeded", Date.now()),
      };
    });
    await t.mutation(internal.jobs.maintenance.pruneCalendarOperations, {});
    expect(await t.run((ctx) => ctx.db.get(ids.succeeded))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(ids.failed))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(ids.pending))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(ids.ambiguous))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(ids.recent))).not.toBeNull();
  });

  test("preserves an aged terminal operation while its booking is pending", async () => {
    const t = convexTest(schema, modules);
    const operationId = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: "booking-retention-user",
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      const bookingId = await ctx.db.insert("bookings", {
        hostUserId: "booking-retention-user",
        startMs: 1,
        endMs: 2,
        timeZone: "UTC",
        requesterName: "R",
        requesterEmail: "r@example.com",
        status: "pending",
        token: "retention-token",
        createdAt: 1,
      });
      return await ctx.db.insert("calendarOperations", {
        connectionId,
        userId: "booking-retention-user",
        idempotencyKey: "booking-op",
        kind: "create",
        status: "succeeded",
        bookingId,
        providerEventId: "event",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await t.mutation(internal.jobs.maintenance.pruneCalendarOperations, {});
    expect(await t.run((ctx) => ctx.db.get(operationId))).not.toBeNull();
  });
});
