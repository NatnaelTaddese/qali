import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../../convex/schema";
import {
  collapseSeries,
  compareSearchResults,
  searchEventsHandler,
} from "../../../convex/domains/calendar/queries";
import type { EventView } from "../../../convex/domains/calendar/model";

import { modules } from "../../testModules";

const HOUR = 60 * 60 * 1000;
const NOW = 1_000 * HOUR;

async function seedUser(t: ReturnType<typeof convexTest>, userId: string) {
  return t.run(async (ctx) => {
    const connectionId = await ctx.db.insert("calendarConnections", {
      userId,
      provider: "google",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
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

type Seed = Awaited<ReturnType<typeof seedUser>>;

function insertEvent(
  t: ReturnType<typeof convexTest>,
  userId: string,
  seed: Seed,
  fields: {
    id: string;
    summary: string;
    startMs: number;
    status?: string;
    seriesId?: string;
    calendarId?: Seed["calendarId"];
  },
) {
  return t.run((ctx) =>
    ctx.db.insert("events", {
      userId,
      connectionId: seed.connectionId,
      localCalendarId: fields.calendarId ?? seed.calendarId,
      providerEventId: fields.id,
      providerSeriesId: fields.seriesId,
      providerUpdatedMs: 1,
      summary: fields.summary,
      startMs: fields.startMs,
      endMs: fields.startMs + HOUR,
      allDay: false,
      status: fields.status ?? "confirmed",
    }),
  );
}

describe("searchEvents", () => {
  test("matches titles by term and prefix, scoped to the caller", async () => {
    const t = convexTest(schema, modules);
    const me = "search-me";
    const other = "search-other";
    const mine = await seedUser(t, me);
    const theirs = await seedUser(t, other);
    await insertEvent(t, me, mine, {
      id: "a",
      summary: "Dentist appointment",
      startMs: NOW + 5 * HOUR,
    });
    await insertEvent(t, me, mine, {
      id: "b",
      summary: "Team standup",
      startMs: NOW + 2 * HOUR,
    });
    await insertEvent(t, other, theirs, {
      id: "c",
      summary: "Dentist for someone else",
      startMs: NOW + 3 * HOUR,
    });

    const rows = await t.run((ctx) =>
      searchEventsHandler(ctx, { userId: me, query: "dent", nowMs: NOW }),
    );
    expect(rows.map((r) => r.providerEventId)).toEqual(["a"]);
  });

  test("returns nothing for a blank query", async () => {
    const t = convexTest(schema, modules);
    const me = "search-blank";
    const mine = await seedUser(t, me);
    await insertEvent(t, me, mine, { id: "a", summary: "Lunch", startMs: NOW });
    const rows = await t.run((ctx) =>
      searchEventsHandler(ctx, { userId: me, query: "   ", nowMs: NOW }),
    );
    expect(rows).toEqual([]);
  });

  test("drops cancelled events and unselected calendars", async () => {
    const t = convexTest(schema, modules);
    const me = "search-filter";
    const mine = await seedUser(t, me);
    const hiddenCalendarId = await t.run((ctx) =>
      ctx.db.insert("calendars", {
        userId: me,
        connectionId: mine.connectionId,
        providerCalendarId: "hidden",
        selected: false,
        isShared: false,
      }),
    );
    await insertEvent(t, me, mine, {
      id: "kept",
      summary: "Lunch with Sam",
      startMs: NOW + HOUR,
    });
    await insertEvent(t, me, mine, {
      id: "cancelled",
      summary: "Lunch (old)",
      startMs: NOW + 2 * HOUR,
      status: "cancelled",
    });
    await insertEvent(t, me, mine, {
      id: "hidden",
      summary: "Lunch on hidden calendar",
      startMs: NOW + 3 * HOUR,
      calendarId: hiddenCalendarId,
    });

    const rows = await t.run((ctx) =>
      searchEventsHandler(ctx, { userId: me, query: "lunch", nowMs: NOW }),
    );
    expect(rows.map((r) => r.providerEventId)).toEqual(["kept"]);
  });

  test("orders upcoming soonest-first, then past most-recent-first", async () => {
    const t = convexTest(schema, modules);
    const me = "search-order";
    const mine = await seedUser(t, me);
    await insertEvent(t, me, mine, {
      id: "past-far",
      summary: "Gym session",
      startMs: NOW - 50 * HOUR,
    });
    await insertEvent(t, me, mine, {
      id: "future-far",
      summary: "Gym session",
      startMs: NOW + 50 * HOUR,
    });
    await insertEvent(t, me, mine, {
      id: "past-near",
      summary: "Gym session",
      startMs: NOW - 5 * HOUR,
    });
    await insertEvent(t, me, mine, {
      id: "future-near",
      summary: "Gym session",
      startMs: NOW + 5 * HOUR,
    });

    const rows = await t.run((ctx) =>
      searchEventsHandler(ctx, { userId: me, query: "gym", nowMs: NOW }),
    );
    expect(rows.map((r) => r.providerEventId)).toEqual([
      "future-near",
      "future-far",
      "past-near",
      "past-far",
    ]);
  });

  test("collapses a recurring series to its next instance", async () => {
    const t = convexTest(schema, modules);
    const me = "search-series";
    const mine = await seedUser(t, me);
    for (let i = -3; i <= 3; i++) {
      await insertEvent(t, me, mine, {
        id: `standup-${i}`,
        summary: "Standup",
        startMs: NOW + i * 24 * HOUR + HOUR,
        seriesId: "standup-series",
      });
    }
    await insertEvent(t, me, mine, {
      id: "one-off",
      summary: "Standup retro",
      startMs: NOW + 10 * HOUR,
    });

    const rows = await t.run((ctx) =>
      searchEventsHandler(ctx, { userId: me, query: "standup", nowMs: NOW }),
    );
    expect(rows.map((r) => r.providerEventId)).toEqual([
      "standup-0",
      "one-off",
    ]);
  });

  test("includes selected public calendars and skips unselected ones", async () => {
    const t = convexTest(schema, modules);
    const me = "search-shared";
    const mine = await seedUser(t, me);
    await t.run(async (ctx) => {
      await ctx.db.insert("calendars", {
        userId: me,
        connectionId: mine.connectionId,
        providerCalendarId: "holidays",
        selected: true,
        isShared: true,
      });
      await ctx.db.insert("calendars", {
        userId: me,
        connectionId: mine.connectionId,
        providerCalendarId: "birthdays",
        selected: false,
        isShared: true,
      });
      for (const [providerCalendarId, id] of [
        ["holidays", "xmas"],
        ["birthdays", "bday"],
      ] as const) {
        await ctx.db.insert("sharedEvents", {
          provider: "google",
          providerCalendarId,
          providerEventId: id,
          providerUpdatedMs: 1,
          summary: "Christmas Day",
          startMs: NOW + 40 * HOUR,
          endMs: NOW + 64 * HOUR,
          allDay: true,
          status: "confirmed",
        });
      }
    });

    const rows = await t.run((ctx) =>
      searchEventsHandler(ctx, { userId: me, query: "christmas", nowMs: NOW }),
    );
    expect(rows.map((r) => r.providerEventId)).toEqual(["xmas"]);
    expect(rows[0]?.userId).toBe(me);
  });
});

describe("collapseSeries", () => {
  const view = (id: string, startMs: number, seriesId?: string): EventView =>
    ({
      _id: id,
      _creationTime: 0,
      userId: "u",
      providerEventId: id,
      providerSeriesId: seriesId,
      providerUpdatedMs: 1,
      startMs,
      endMs: startMs + HOUR,
      allDay: false,
      status: "confirmed",
    }) as unknown as EventView;

  test("keeps the most recent instance when the series is all in the past", () => {
    const out = collapseSeries(
      [view("a", NOW - 30 * HOUR, "s"), view("b", NOW - 3 * HOUR, "s")],
      NOW,
    );
    expect(out.map((e) => e._id)).toEqual(["b"]);
  });

  test("sorts upcoming before past", () => {
    const rows = [view("p", NOW - HOUR), view("f", NOW + HOUR)].sort(
      compareSearchResults(NOW),
    );
    expect(rows.map((e) => e._id)).toEqual(["f", "p"]);
  });
});
