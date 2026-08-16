/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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
      await ctx.db.insert("calendarOperations", {
        connectionId,
        userId,
        idempotencyKey: "op",
        kind: "create",
        status: "pending",
        createdAt: 1,
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

    const res = await t.mutation(internal.maintenance.purgeUserData, {
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
      expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(0);
      const calendars = await ctx.db.query("calendars").collect();
      expect(calendars.map((c) => c.userId)).toEqual(["bystander"]);
      const waitlist = await ctx.db.query("waitlist").collect();
      expect(waitlist.map((w) => w.email)).toEqual(["keep@example.com"]);
    });
  });
});
