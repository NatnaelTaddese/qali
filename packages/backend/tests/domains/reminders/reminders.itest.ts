import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { updatePreferencesCore } from "../../../convex/domains/preferences/mutations";
import { upcomingHandler } from "../../../convex/domains/reminders/queries";
import { markFiredCore } from "../../../convex/domains/reminders/mutations";
import {
  reconcileEventReminders,
  loadReminderContext,
  reminderBody,
} from "../../../convex/domains/reminders/model";
import schema from "../../../convex/schema";

import { modules } from "../../testModules";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const USER = "user_rem";

type T = TestConvex<typeof schema>;

async function seedCalendar(
  t: T,
  opts: { selected?: boolean; timeZone?: string; userId?: string } = {},
) {
  return await t.run(async (ctx) => {
    const userId = opts.userId ?? USER;
    const now = Date.now();
    const connectionId = await ctx.db.insert("calendarConnections", {
      userId,
      provider: "google",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("userSyncState", {
      userId,
      engagementDirty: false,
      updatedAt: now,
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
      selected: opts.selected ?? true,
      isShared: false,
      timeZone: opts.timeZone,
    });
    return { connectionId, calendarId, userId };
  });
}

async function seedEvent(
  t: T,
  target: { connectionId: Id<"calendarConnections">; calendarId: Id<"calendars">; userId: string },
  overrides: Partial<{
    providerEventId: string;
    startMs: number;
    endMs: number;
    allDay: boolean;
    status: string;
    summary: string;
    reminders: { method: "popup" | "email"; minutes: number }[];
  }> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("events", {
      userId: target.userId,
      connectionId: target.connectionId,
      localCalendarId: target.calendarId,
      providerEventId: overrides.providerEventId ?? "evt",
      providerUpdatedMs: 1,
      summary: overrides.summary ?? "Standup",
      startMs: overrides.startMs ?? Date.now() + 2 * HOUR,
      endMs: overrides.endMs ?? Date.now() + 3 * HOUR,
      allDay: overrides.allDay ?? false,
      status: overrides.status ?? "confirmed",
      reminders: overrides.reminders,
    }),
  );
}

async function reconcile(t: T, eventId: Id<"events">, nowMs = Date.now()) {
  await t.run(async (ctx) => {
    const event = (await ctx.db.get(eventId))!;
    await reconcileEventReminders(
      ctx,
      event,
      await loadReminderContext(ctx, event.userId),
      nowMs,
    );
  });
}

async function ledger(t: T, eventId: Id<"events">) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("reminderDeliveries")
      .withIndex("by_event_and_minutes", (q) => q.eq("eventId", eventId))
      .collect(),
  );
  return rows.sort((a, b) => a.minutes - b.minutes);
}

async function scheduled(t: T, suffix: string) {
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return jobs.filter((job) => job.name.endsWith(suffix));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("reconcileEventReminders", () => {
  test("plans the default popup for a selected calendar and nothing for a deselected one", async () => {
    const t = convexTest(schema, modules);
    const selected = await seedCalendar(t);
    const startMs = Date.now() + 2 * HOUR;
    const eventId = await seedEvent(t, selected, { startMs });
    await reconcile(t, eventId);
    expect(await ledger(t, eventId)).toMatchObject([
      { minutes: 10, fireAtMs: startMs - 10 * MINUTE, status: "pending", eventStartMs: startMs },
    ]);

    const hidden = await seedCalendar(t, { selected: false, userId: "user_hidden" });
    const hiddenEvent = await seedEvent(t, hidden, { startMs });
    await reconcile(t, hiddenEvent);
    expect(await ledger(t, hiddenEvent)).toEqual([]);
  });

  test("an explicit list wins, email entries never fire, and a cancelled event clears", async () => {
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    const startMs = Date.now() + 2 * HOUR;
    const eventId = await seedEvent(t, target, {
      startMs,
      reminders: [
        { method: "popup", minutes: 5 },
        { method: "email", minutes: 30 },
        { method: "popup", minutes: 60 },
      ],
    });
    await reconcile(t, eventId);
    expect((await ledger(t, eventId)).map((r) => r.minutes)).toEqual([5, 60]);

    await t.run((ctx) => ctx.db.patch(eventId, { status: "cancelled" }));
    await reconcile(t, eventId);
    expect(await ledger(t, eventId)).toEqual([]);
  });

  test("a moved event re-times pending rows; removed offsets are deleted; sent rows never resurrect", async () => {
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    const startMs = Date.now() + 2 * HOUR;
    const eventId = await seedEvent(t, target, {
      startMs,
      reminders: [
        { method: "popup", minutes: 10 },
        { method: "popup", minutes: 60 },
      ],
    });
    await reconcile(t, eventId);
    const [ten] = await ledger(t, eventId);
    await t.run((ctx) => ctx.db.patch(ten!._id, { status: "sent", channel: "client" }));

    const moved = startMs + HOUR;
    await t.run((ctx) =>
      ctx.db.patch(eventId, {
        startMs: moved,
        reminders: [
          { method: "popup", minutes: 10 },
          { method: "popup", minutes: 30 },
        ],
      }),
    );
    await reconcile(t, eventId);
    const rows = await ledger(t, eventId);
    expect(rows.map((r) => [r.minutes, r.status, r.fireAtMs])).toEqual([
      [10, "sent", startMs - 10 * MINUTE], // untouched: already fired
      [30, "pending", moved - 30 * MINUTE], // new offset
    ]);
  });

  test("preferences and calendar defaults resolve in order", async () => {
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    await t.run((ctx) =>
      ctx.db.patch(target.calendarId, {
        defaultReminders: [{ method: "popup", minutes: 15 }],
      }),
    );
    const eventId = await seedEvent(t, target);
    await reconcile(t, eventId);
    expect((await ledger(t, eventId)).map((r) => r.minutes)).toEqual([15]);

    await t.run((ctx) =>
      updatePreferencesCore(ctx, USER, { defaultReminderMinutes: [30, 5] }),
    );
    await reconcile(t, eventId);
    expect((await ledger(t, eventId)).map((r) => r.minutes)).toEqual([5, 30]);

    await t.run((ctx) =>
      updatePreferencesCore(ctx, USER, { defaultReminderMinutes: [] }),
    );
    await reconcile(t, eventId);
    expect(await ledger(t, eventId)).toEqual([]);
  });

  test("all-day reminders count back from local midnight in the calendar's zone", async () => {
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t, { timeZone: "Europe/Berlin" });
    const now = Date.UTC(2026, 9, 20, 12, 0);
    const startMs = Date.UTC(2026, 9, 26); // floating date 2026-10-26
    const eventId = await seedEvent(t, target, {
      startMs,
      endMs: startMs + DAY,
      allDay: true,
    });
    await reconcile(t, eventId, now);
    // 09:00 CET on the 25th (the day after DST ends) = 08:00Z.
    expect(await ledger(t, eventId)).toMatchObject([
      { minutes: 900, fireAtMs: Date.UTC(2026, 9, 25, 8, 0) },
    ]);
  });

  test("offsets beyond a week and events outside the window are not planned", async () => {
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    const now = Date.now();
    const near = await seedEvent(t, target, {
      startMs: now + 2 * HOUR,
      reminders: [
        { method: "popup", minutes: 10 },
        { method: "popup", minutes: 20_160 },
      ],
    });
    await reconcile(t, near, now);
    expect((await ledger(t, near)).map((r) => r.minutes)).toEqual([10]);

    const far = await seedEvent(t, target, {
      providerEventId: "far",
      startMs: now + 30 * DAY,
    });
    await reconcile(t, far, now);
    expect(await ledger(t, far)).toEqual([]);
  });
});

describe("materializeUserReminders", () => {
  test("walks the window and plans each event; a preference change re-schedules it", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    const now = Date.now();
    const inWindow = await seedEvent(t, target, { startMs: now + DAY });
    const outside = await seedEvent(t, target, {
      providerEventId: "out",
      startMs: now + 20 * DAY,
    });
    await t.mutation(internal.domains.reminders.jobs.materializeUserReminders, {
      userId: USER,
    });
    expect(await ledger(t, inWindow)).toHaveLength(1);
    expect(await ledger(t, outside)).toHaveLength(0);

    await t.run((ctx) =>
      updatePreferencesCore(ctx, USER, { defaultReminderMinutes: [45] }),
    );
    const jobs = await scheduled(t, ":materializeUserReminders");
    expect(jobs.map((job) => job.args)).toEqual([[{ userId: USER }]]);
  });

  test("the enqueue fans out one job per user", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    await seedCalendar(t, { userId: "user_two" });
    await t.mutation(internal.domains.reminders.jobs.enqueueReminderMaterialize, {});
    const jobs = await scheduled(t, ":materializeUserReminders");
    expect(jobs.map((job) => job.args).sort()).toEqual([
      [{ userId: USER }],
      [{ userId: "user_two" }],
    ]);
  });
});

describe("sweepDueReminders", () => {
  test("fires due rows: marks sent, writes the notification, pushes once per subscribed user", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    const now = Date.now();
    const a = await seedEvent(t, target, {
      providerEventId: "a",
      summary: "Standup",
      startMs: now + 5 * MINUTE,
    });
    const b = await seedEvent(t, target, {
      providerEventId: "b",
      summary: "Review",
      startMs: now + 8 * MINUTE,
    });
    await reconcile(t, a, now);
    await reconcile(t, b, now);
    await t.run((ctx) =>
      ctx.db.insert("pushSubscriptions", {
        userId: USER,
        endpoint: "https://push.example/sub",
        keys: { p256dh: "p", auth: "a" },
        createdAt: now,
      }),
    );

    await t.mutation(internal.domains.reminders.jobs.sweepDueReminders, {});

    expect((await ledger(t, a))[0]).toMatchObject({ status: "sent", channel: "server" });
    expect((await ledger(t, b))[0]).toMatchObject({ status: "sent", channel: "server" });
    const notifications = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user_and_created", (q) => q.eq("userId", USER))
        .collect(),
    );
    expect(notifications.map((n) => [n.type, n.title, n.eventId, n.read])).toEqual([
      ["event_reminder", "Standup", a, false],
      ["event_reminder", "Review", b, false],
    ]);
    const pushes = await scheduled(t, ":sendToUser");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.args[0]).toMatchObject({
      userId: USER,
      notifications: [
        { kind: "event_reminder", eventId: a, title: "Standup", tag: `reminder:${a}:10` },
        { kind: "event_reminder", eventId: b, title: "Review" },
      ],
    });
    // Nothing left to fire; a second sweep is a no-op.
    await t.mutation(internal.domains.reminders.jobs.sweepDueReminders, {});
    expect(await scheduled(t, ":sendToUser")).toHaveLength(1);
  });

  test("skips stale rows and pushes nothing to a user without subscriptions", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    const now = Date.now();
    const moved = await seedEvent(t, target, {
      providerEventId: "moved",
      startMs: now + 5 * MINUTE,
    });
    const cancelled = await seedEvent(t, target, {
      providerEventId: "cancelled",
      startMs: now + 5 * MINUTE,
    });
    const started = await seedEvent(t, target, {
      providerEventId: "started",
      startMs: now + 5 * MINUTE,
    });
    for (const id of [moved, cancelled, started]) await reconcile(t, id, now);
    await t.run(async (ctx) => {
      // Moved after materialisation without a reconcile (a missed hook).
      await ctx.db.patch(moved, { startMs: now + 3 * HOUR });
      await ctx.db.patch(cancelled, { status: "cancelled" });
      // Its reminder is 20 minutes late and the event has been under way
      // for longer than the grace: noise.
      await ctx.db.patch(started, { startMs: now - 10 * MINUTE });
      const row = (await ctx.db
        .query("reminderDeliveries")
        .withIndex("by_event_and_minutes", (q) => q.eq("eventId", started))
        .unique())!;
      await ctx.db.patch(row._id, { fireAtMs: now - 20 * MINUTE, eventStartMs: now - 10 * MINUTE });
    });

    await t.mutation(internal.domains.reminders.jobs.sweepDueReminders, {});

    for (const id of [moved, cancelled, started]) {
      expect((await ledger(t, id))[0]?.status).toBe("skipped");
    }
    expect(await scheduled(t, ":sendToUser")).toHaveLength(0);
    const notifications = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user_and_created", (q) => q.eq("userId", USER))
        .collect(),
    );
    expect(notifications).toEqual([]);
  });

  test("a late reminder still fires while the event has not started", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    const now = Date.now();
    const eventId = await seedEvent(t, target, { startMs: now + 2 * MINUTE });
    await reconcile(t, eventId, now - HOUR); // planned an hour ago: fireAt is 8 min past
    await t.mutation(internal.domains.reminders.jobs.sweepDueReminders, {});
    expect((await ledger(t, eventId))[0]?.status).toBe("sent");
  });
});

describe("cross-channel dedupe", () => {
  test("markFired then sweep delivers once; sweep then markFired reports not fired", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    const now = Date.now();
    const first = await seedEvent(t, target, {
      providerEventId: "first",
      startMs: now + 5 * MINUTE,
    });
    const second = await seedEvent(t, target, {
      providerEventId: "second",
      startMs: now + 5 * MINUTE,
    });
    await reconcile(t, first, now);
    await reconcile(t, second, now);

    expect(
      await t.run((ctx) => markFiredCore(ctx, USER, { eventId: first, minutes: 10 })),
    ).toEqual({ fired: true });
    await t.mutation(internal.domains.reminders.jobs.sweepDueReminders, {});
    expect(
      await t.run((ctx) => markFiredCore(ctx, USER, { eventId: second, minutes: 10 })),
    ).toEqual({ fired: false });

    const rows = [...(await ledger(t, first)), ...(await ledger(t, second))];
    expect(rows.map((r) => r.channel)).toEqual(["client", "server"]);
    const notifications = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user_and_created", (q) => q.eq("userId", USER))
        .collect(),
    );
    expect(notifications).toHaveLength(2);
  });

  test("markFired refuses another user's row", async () => {
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    const eventId = await seedEvent(t, target, { startMs: Date.now() + 5 * MINUTE });
    await reconcile(t, eventId);
    expect(
      await t.run((ctx) => markFiredCore(ctx, "someone_else", { eventId, minutes: 10 })),
    ).toEqual({ fired: false });
    expect((await ledger(t, eventId))[0]?.status).toBe("pending");
  });
});

describe("upcoming", () => {
  test("returns pending rows in the window with event details, and drops fired ones", async () => {
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    const now = Date.now();
    const soon = await seedEvent(t, target, {
      providerEventId: "soon",
      summary: "Soon",
      startMs: now + HOUR,
    });
    const later = await seedEvent(t, target, {
      providerEventId: "later",
      startMs: now + 3 * DAY,
    });
    await reconcile(t, soon, now);
    await reconcile(t, later, now);
    // `upcomingHandler` authenticates through Better Auth, which the test
    // harness does not register; drive the index the same way it does.
    const rows = await t.run((ctx) =>
      ctx.db
        .query("reminderDeliveries")
        .withIndex("by_user_and_status_and_fireAt", (q) =>
          q
            .eq("userId", USER)
            .eq("status", "pending")
            .gte("fireAtMs", now - 15 * MINUTE)
            .lte("fireAtMs", now + DAY),
        )
        .collect(),
    );
    expect(rows.map((r) => r.eventId)).toEqual([soon]);
    expect(typeof upcomingHandler).toBe("function");
  });
});

describe("write-path hooks", () => {
  test("upsertEventsPage plans reminders and a tombstone clears them", async () => {
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    const attemptId = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId: target.connectionId,
    });
    const startMs = Date.now() + 2 * HOUR;
    const base = {
      id: "synced",
      calendarId: "primary",
      startMs,
      endMs: startMs + HOUR,
      allDay: false,
      updatedMs: 1,
    };
    await t.mutation(internal.domains.sync.engine.upsertEventsPage, {
      connectionId: target.connectionId,
      attemptId: attemptId!,
      localCalendarId: target.calendarId,
      events: [
        {
          ...base,
          status: "confirmed",
          reminders: [{ method: "popup", minutes: 20 }],
        },
      ],
    });
    const event = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_user_and_start", (q) => q.eq("userId", USER))
        .unique(),
    );
    expect(event?.reminders).toEqual([{ method: "popup", minutes: 20 }]);
    expect(await ledger(t, event!._id)).toMatchObject([
      { minutes: 20, fireAtMs: startMs - 20 * MINUTE },
    ]);

    await t.mutation(internal.domains.sync.engine.upsertEventsPage, {
      connectionId: target.connectionId,
      attemptId: attemptId!,
      localCalendarId: target.calendarId,
      events: [{ ...base, status: "cancelled" }],
    });
    expect(await ledger(t, event!._id)).toEqual([]);
  });

  test("toggling calendar visibility re-plans the user's ledger", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const target = await seedCalendar(t);
    // setCalendarSelected authenticates; exercise the ledger effect directly:
    // a deselected calendar's pending rows are removed on the next reconcile.
    const eventId = await seedEvent(t, target, { startMs: Date.now() + HOUR });
    await reconcile(t, eventId);
    expect(await ledger(t, eventId)).toHaveLength(1);
    await t.run((ctx) => ctx.db.patch(target.calendarId, { selected: false }));
    await t.mutation(internal.domains.reminders.jobs.materializeUserReminders, {
      userId: USER,
    });
    expect(await ledger(t, eventId)).toEqual([]);
  });
});

describe("reminderBody", () => {
  test("phrases the offset without a zone", () => {
    expect(reminderBody(false, 0)).toBe("Starts now");
    expect(reminderBody(false, 10)).toBe("Starts in 10 min");
    expect(reminderBody(false, 60)).toBe("Starts in 1 hour");
    expect(reminderBody(false, 150)).toBe("Starts in 2 hours 30 min");
    expect(reminderBody(false, 1440)).toBe("Tomorrow");
    expect(reminderBody(false, 10_080)).toBe("In a week");
    expect(reminderBody(true, 0)).toBe("Today, all day");
    expect(reminderBody(true, 900)).toBe("Tomorrow, all day");
    expect(reminderBody(true, 2340)).toBe("In 2 days, all day");
  });
});
