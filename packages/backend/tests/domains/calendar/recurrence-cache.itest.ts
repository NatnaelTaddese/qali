import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import schema from "../../../convex/schema";
import { upsertProviderRecurringSeriesHandler } from "../../../convex/domains/calendar/mutations";
import { seriesRuleFor } from "../../../convex/domains/calendar/queries";

import { modules } from "../../testModules";

const RULE = ["RRULE:FREQ=DAILY;COUNT=3"];

test("an occurrence edited after its master still finds the rule once refreshed", () => {
  const cached = { recurrence: RULE, providerUpdatedMs: 100 };
  // The occurrence was changed on its own after the master: a miss.
  expect(seriesRuleFor(cached, 150)).toBeNull();
  // The refresh records the occurrence version it fetched for.
  expect(seriesRuleFor({ ...cached, currentForUpdatedMs: 150 }, 150)).toEqual(RULE);
  // A later change to the occurrence asks again.
  expect(seriesRuleFor({ ...cached, currentForUpdatedMs: 150 }, 200)).toBeNull();
  expect(seriesRuleFor(cached, 100)).toEqual(RULE);
});

test("the occurrence version survives a re-cache of the same master, not a new one", async () => {
  const t = convexTest(schema, modules);
  const userId = "series-user";
  const ids = await t.run(async (ctx) => {
    const connectionId = await ctx.db.insert("calendarConnections", {
      userId,
      provider: "google",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    const localCalendarId = await ctx.db.insert("calendars", {
      userId,
      connectionId,
      providerCalendarId: "primary",
      selected: true,
      isShared: false,
    });
    return { connectionId, localCalendarId };
  });
  const cache = (providerUpdatedMs: number, currentForUpdatedMs?: number) =>
    t.run(async (ctx) => {
      await upsertProviderRecurringSeriesHandler(ctx, {
        userId,
        ...ids,
        providerEventId: "master",
        recurrence: RULE,
        providerUpdatedMs,
        currentForUpdatedMs,
      });
      return await ctx.db
        .query("recurringSeries")
        .withIndex("by_connection_and_localCalendarId_and_providerEventId", (q) =>
          q
            .eq("connectionId", ids.connectionId)
            .eq("localCalendarId", ids.localCalendarId)
            .eq("providerEventId", "master"),
        )
        .unique();
    });

  expect((await cache(100, 150))?.currentForUpdatedMs).toBe(150);
  expect((await cache(100))?.currentForUpdatedMs).toBe(150);
  expect((await cache(300))?.currentForUpdatedMs).toBeUndefined();
});
