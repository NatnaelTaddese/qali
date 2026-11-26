import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { readPersonalEventsInRange } from "../../../convex/domains/calendar/queries";
import schema from "../../../convex/schema";

import { modules } from "../../testModules";

// Synced events remember the zone the provider says they are set in, so the
// apps can show it and open an edit in it.

function providerEvent(id: string, timeZone?: string, calendarId = "primary") {
  return {
    id,
    calendarId,
    startMs: 1_000_000,
    endMs: 1_003_600,
    allDay: false,
    status: "confirmed" as const,
    updatedMs: 1_000,
    ...(timeZone ? { timeZone } : {}),
  };
}

async function setup(t: ReturnType<typeof convexTest>, userId: string) {
  return await t.run(async (ctx) => {
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
      nextSyncDueAt: 0,
      syncIntervalMs: 15 * 60 * 1_000,
    });
    const calendarId = await ctx.db.insert("calendars", {
      userId,
      connectionId,
      providerCalendarId: "primary",
      selected: true,
      isShared: false,
    });
    return { connectionId, calendarId };
  });
}

async function readRange(
  t: ReturnType<typeof convexTest>,
  userId: string,
  calendarId: Id<"calendars">,
) {
  return await t.run(async (ctx) => {
    const calendar = await ctx.db.get(calendarId);
    return await readPersonalEventsInRange(ctx, userId, [calendar!], 0, 2_000_000);
  });
}

describe("event time zone", () => {
  test("sync stores the event's zone and the range read returns it", async () => {
    const t = convexTest(schema, modules);
    const userId = "zone-sync";
    const { connectionId, calendarId } = await setup(t, userId);
    const attemptId = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId,
    });
    await t.mutation(internal.domains.sync.engine.upsertEventsPage, {
      connectionId,
      attemptId: attemptId!,
      localCalendarId: calendarId,
      events: [providerEvent("tokyo", "Asia/Tokyo"), providerEvent("floating")],
    });

    const rows = await readRange(t, userId, calendarId);
    const byId = Object.fromEntries(rows.map((row) => [row.providerEventId, row]));
    expect(byId.tokyo?.timeZone).toBe("Asia/Tokyo");
    // No zone from the provider stays absent rather than guessed.
    expect(byId.floating?.timeZone).toBeUndefined();

    // A later sync that moves the event to another zone replaces it, and one
    // that drops the zone clears it.
    await t.mutation(internal.domains.sync.engine.upsertEventsPage, {
      connectionId,
      attemptId: attemptId!,
      localCalendarId: calendarId,
      events: [providerEvent("tokyo", "Europe/Paris"), providerEvent("floating", "UTC")],
    });
    const moved = await readRange(t, userId, calendarId);
    expect(
      Object.fromEntries(moved.map((row) => [row.providerEventId, row.timeZone])),
    ).toEqual({ tokyo: "Europe/Paris", floating: "UTC" });

    await t.mutation(internal.domains.sync.engine.upsertEventsPage, {
      connectionId,
      attemptId: attemptId!,
      localCalendarId: calendarId,
      events: [providerEvent("tokyo")],
    });
    const cleared = await t.run((ctx) =>
      ctx.db
        .query("events")
        .filter((q) => q.eq(q.field("providerEventId"), "tokyo"))
        .unique(),
    );
    expect(cleared?.timeZone).toBeUndefined();
  });

  test("public-calendar events keep their zone too", async () => {
    const t = convexTest(schema, modules);
    const claim = await t.mutation(internal.domains.sync.engine.claimSharedCalendarSync, {
      provider: "google",
      providerCalendarId: "holidays",
      refreshIntervalMs: 60_000,
    });
    await t.mutation(internal.domains.sync.engine.upsertSharedEventsPage, {
      provider: "google",
      providerCalendarId: "holidays",
      attemptId: claim.attemptId!,
      events: [providerEvent("launch", "America/New_York", "holidays")],
    });
    const rows = await t.run((ctx) => ctx.db.query("sharedEvents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.timeZone).toBe("America/New_York");
  });

  test("a create or update writes the zone into the local mirror", async () => {
    const t = convexTest(schema, modules);
    const userId = "zone-mirror";
    const { connectionId, calendarId } = await setup(t, userId);

    await t.mutation(internal.domains.calendar.mutations.mirrorProviderEvent, {
      userId,
      connectionId,
      localCalendarId: calendarId,
      event: providerEvent("created", "Asia/Kolkata"),
    });
    expect((await readRange(t, userId, calendarId))[0]?.timeZone).toBe("Asia/Kolkata");

    await t.mutation(internal.domains.calendar.mutations.mirrorProviderEvent, {
      userId,
      connectionId,
      localCalendarId: calendarId,
      event: { ...providerEvent("created", "Australia/Sydney"), updatedMs: 2_000 },
    });
    const rows = await readRange(t, userId, calendarId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.timeZone).toBe("Australia/Sydney");
  });
});
