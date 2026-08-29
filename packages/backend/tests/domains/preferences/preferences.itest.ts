import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { updatePreferencesCore } from "../../../convex/domains/preferences/mutations";
import schema from "../../../convex/schema";

import { modules } from "../../testModules";

/** The preferences row is a per-user upsert: sets patch, resets remove, and
 * defaultCalendarId is validated against ownership and writability. */
describe("user preferences", () => {
  test("upserts one row and patches it on later calls", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_prefs";

    await t.run((ctx) =>
      updatePreferencesCore(ctx, userId, { weekStartsOn: 1 }),
    );
    await t.run((ctx) =>
      updatePreferencesCore(ctx, userId, { timeFormat: "24h" }),
    );

    const rows = await t.run((ctx) =>
      ctx.db
        .query("userPreferences")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ weekStartsOn: 1, timeFormat: "24h" });
  });

  test("reset removes the field, and wins over a set in the same call", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_reset";

    await t.run((ctx) =>
      updatePreferencesCore(ctx, userId, {
        timeFormat: "24h",
        defaultView: "month",
      }),
    );
    await t.run((ctx) =>
      updatePreferencesCore(ctx, userId, {
        timeFormat: "12h",
        reset: ["timeFormat"],
      }),
    );

    const row = await t.run((ctx) =>
      ctx.db
        .query("userPreferences")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique(),
    );
    expect(row?.timeFormat).toBeUndefined();
    expect(row?.defaultView).toBe("month");
  });

  test("rejects an unknown time zone", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) =>
        updatePreferencesCore(ctx, "user_tz", { timeZone: "Not/AZone" }),
      ),
    ).rejects.toThrow("Unknown time zone");
    await t.run((ctx) =>
      updatePreferencesCore(ctx, "user_tz", { timeZone: "Europe/Berlin" }),
    );
  });

  test("defaultCalendarId must be an owned, writable, non-shared calendar", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_default_cal";

    const { own, foreign, shared, readOnly } = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      const base = {
        connectionId,
        selected: true,
        isShared: false,
      };
      return {
        own: await ctx.db.insert("calendars", {
          ...base,
          userId,
          providerCalendarId: "own",
          accessRole: "owner",
        }),
        foreign: await ctx.db.insert("calendars", {
          ...base,
          userId: "someone_else",
          providerCalendarId: "foreign",
          accessRole: "owner",
        }),
        shared: await ctx.db.insert("calendars", {
          ...base,
          userId,
          providerCalendarId: "holidays",
          accessRole: "reader",
          isShared: true,
        }),
        readOnly: await ctx.db.insert("calendars", {
          ...base,
          userId,
          providerCalendarId: "subscribed",
          accessRole: "reader",
        }),
      };
    });

    for (const bad of [foreign, shared, readOnly]) {
      await expect(
        t.run((ctx) =>
          updatePreferencesCore(ctx, userId, { defaultCalendarId: bad }),
        ),
      ).rejects.toThrow("Calendar not found or read-only");
    }

    await t.run((ctx) =>
      updatePreferencesCore(ctx, userId, { defaultCalendarId: own }),
    );
    const row = await t.run((ctx) =>
      ctx.db
        .query("userPreferences")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique(),
    );
    expect(row?.defaultCalendarId).toBe(own);
  });
});
