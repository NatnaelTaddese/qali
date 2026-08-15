/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import schema from "../../schema";

// Globs from the convex root (two levels up) so convex-test loads the whole
// function surface, not just this domain folder.
const modules = import.meta.glob("../../**/*.ts");

/** A minimal stored event for the given user/calendar/generation. */
function eventDoc(
  userId: string,
  calendarId: string,
  googleEventId: string,
  syncGeneration?: number,
) {
  return {
    userId,
    calendarId,
    googleEventId,
    startMs: 1_000,
    endMs: 2_000,
    allDay: false,
    status: "confirmed",
    googleUpdatedMs: 1_000,
    ...(syncGeneration !== undefined ? { syncGeneration } : {}),
  };
}

describe("per-user sync lease", () => {
  test("is mutually exclusive and released only by the holding attempt", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_lease";
    await t.mutation(internal.googleSync.ensureSyncState, { userId });

    const first = await t.mutation(internal.googleSync.claimSyncLease, {
      userId,
    });
    expect(typeof first).toBe("string");

    // A second run cannot claim while the lease is live.
    const second = await t.mutation(internal.googleSync.claimSyncLease, {
      userId,
    });
    expect(second).toBeNull();

    // An outcome from a different (stale) attempt must not release the lease.
    await t.mutation(internal.googleSync.recordSyncOutcome, {
      userId,
      attemptId: "not-the-holder",
      status: "idle",
      active: false,
    });
    expect(
      await t.mutation(internal.googleSync.claimSyncLease, { userId }),
    ).toBeNull();

    // The holder releasing it frees the lease for the next run.
    await t.mutation(internal.googleSync.recordSyncOutcome, {
      userId,
      attemptId: first as string,
      status: "idle",
      active: false,
    });
    expect(
      typeof (await t.mutation(internal.googleSync.claimSyncLease, { userId })),
    ).toBe("string");
  });
});

describe("generation-based full-resync sweep", () => {
  test("keeps the current generation and deletes older/absent ones", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_gen";
    const calendarId = "cal_1";
    await t.run(async (ctx) => {
      await ctx.db.insert("events", eventDoc(userId, calendarId, "cur", 2));
      await ctx.db.insert("events", eventDoc(userId, calendarId, "old", 1));
      await ctx.db.insert("events", eventDoc(userId, calendarId, "nogen"));
      // Another calendar's current-gen row must be untouched by this sweep.
      await ctx.db.insert("events", eventDoc(userId, "cal_2", "other", 1));
    });

    let cursor: string | null = null;
    let done = false;
    while (!done) {
      const res: { cursor: string | null; done: boolean } = await t.mutation(
        internal.googleSync.sweepStaleCalendarEventsBatch,
        { userId, googleCalendarId: calendarId, keepGeneration: 2, cursor },
      );
      cursor = res.cursor;
      done = res.done;
    }

    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_user_and_start", (q) => q.eq("userId", userId))
        .collect(),
    );
    const ids = remaining.map((e) => e.googleEventId).sort();
    // cal_1 keeps only the current generation; cal_2 is left alone entirely.
    expect(ids).toEqual(["cur", "other"]);
  });
});

describe("contact deletion cascade", () => {
  test("a tombstoned contact whose person has no other source is removed", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_c1";
    await t.mutation(internal.googleSync.upsertContactsPage, {
      userId,
      contacts: [
        {
          resourceName: "people/1",
          deleted: false,
          displayName: "Alice",
          emails: ["alice@example.com"],
          phones: [],
        },
      ],
    });
    let people = await t.run(async (ctx) =>
      ctx.db.query("people").collect(),
    );
    expect(people).toHaveLength(1);
    expect(people[0].sources).toContain("connection");

    await t.mutation(internal.googleSync.upsertContactsPage, {
      userId,
      contacts: [
        {
          resourceName: "people/1",
          deleted: true,
          emails: ["alice@example.com"],
          phones: [],
        },
      ],
    });

    const contacts = await t.run(async (ctx) =>
      ctx.db.query("contacts").collect(),
    );
    expect(contacts).toHaveLength(0);
    people = await t.run(async (ctx) => ctx.db.query("people").collect());
    expect(people).toHaveLength(0);
  });

  test("a person also seen as an attendee keeps the row, losing only 'connection'", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_c2";
    const email = "bob@example.com";
    // Bob is both a saved connection and a calendar attendee.
    await t.mutation(internal.googleSync.upsertContactsPage, {
      userId,
      contacts: [
        {
          resourceName: "people/2",
          deleted: false,
          displayName: "Bob",
          emails: [email],
          phones: [],
        },
      ],
    });
    await t.run(async (ctx) => {
      const p = await ctx.db
        .query("people")
        .withIndex("by_user_and_email", (q) =>
          q.eq("userId", userId).eq("email", email),
        )
        .unique();
      await ctx.db.patch(p!._id, { sources: ["connection", "attendee"] });
    });

    await t.mutation(internal.googleSync.upsertContactsPage, {
      userId,
      contacts: [
        { resourceName: "people/2", deleted: true, emails: [email], phones: [] },
      ],
    });

    const people = await t.run(async (ctx) =>
      ctx.db.query("people").collect(),
    );
    expect(people).toHaveLength(1);
    expect(people[0].sources).toEqual(["attendee"]);
  });
});

describe("sync lease recovery", () => {
  test("an expired lease is reclaimable by a new attempt, stranding the old one", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_recover";
    await t.mutation(internal.googleSync.ensureSyncState, { userId });

    const stale = await t.mutation(internal.googleSync.claimSyncLease, {
      userId,
    });
    expect(typeof stale).toBe("string");

    // Simulate the holder dying: its lease lapses without ever being released.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("syncState")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      await ctx.db.patch(row!._id, { syncLeaseExpiresAt: Date.now() - 1 });
    });

    const fresh = await t.mutation(internal.googleSync.claimSyncLease, {
      userId,
    });
    expect(typeof fresh).toBe("string");
    expect(fresh).not.toBe(stale);

    // The stranded original attempt can no longer release or clobber the lease.
    await t.mutation(internal.googleSync.recordSyncOutcome, {
      userId,
      attemptId: stale as string,
      status: "idle",
      active: false,
    });
    expect(
      await t.mutation(internal.googleSync.claimSyncLease, { userId }),
    ).toBeNull();
  });
});

describe("adaptive sync cadence", () => {
  test("an idle run backs the interval off; an active run resets it to the floor", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_cadence";
    await t.mutation(internal.googleSync.ensureSyncState, { userId });

    const readState = () =>
      t.run(async (ctx) =>
        ctx.db
          .query("syncState")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .unique(),
      );
    const floor = (await readState())!.syncIntervalMs!;

    // A quiet run doubles the interval and schedules the next poll further out.
    let attempt = await t.mutation(internal.googleSync.claimSyncLease, {
      userId,
    });
    await t.mutation(internal.googleSync.recordSyncOutcome, {
      userId,
      attemptId: attempt as string,
      status: "idle",
      active: false,
    });
    let state = (await readState())!;
    expect(state.syncIntervalMs).toBe(floor * 2);
    expect(state.status).toBe("idle");
    expect(state.syncAttemptId).toBeUndefined();
    expect(state.nextSyncDueAt).toBeGreaterThan(Date.now());

    // Any change (or a user-initiated sync) snaps the interval back to the floor.
    attempt = await t.mutation(internal.googleSync.claimSyncLease, { userId });
    await t.mutation(internal.googleSync.recordSyncOutcome, {
      userId,
      attemptId: attempt as string,
      status: "idle",
      active: true,
    });
    expect((await readState())!.syncIntervalMs).toBe(floor);
  });
});

describe("full-resync generation vs cursor", () => {
  test("generation advances independently of the sync token so an incomplete run withholds the cursor", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_commit";
    const googleCalendarId = "cal_commit";
    await t.run((ctx) =>
      ctx.db.insert("calendars", {
        userId,
        googleCalendarId,
        selected: true,
        syncToken: "old",
        syncGeneration: 1,
      }),
    );

    const readCal = () =>
      t.run(async (ctx) =>
        ctx.db
          .query("calendars")
          .withIndex("by_user_and_googleCalendarId", (q) =>
            q.eq("userId", userId).eq("googleCalendarId", googleCalendarId),
          )
          .unique(),
      );

    expect(
      await t.mutation(internal.googleSync.beginCalendarFullResync, {
        userId,
        googleCalendarId,
      }),
    ).toBe(2);

    // Committing without a token (an incomplete/failed page) bumps the generation
    // but keeps the old cursor, so the next run redoes the full resync.
    await t.mutation(internal.googleSync.commitCalendarFullResync, {
      userId,
      googleCalendarId,
      syncGeneration: 2,
    });
    let cal = (await readCal())!;
    expect(cal.syncGeneration).toBe(2);
    expect(cal.syncToken).toBe("old");

    // A complete run commits both generation and the fresh cursor.
    await t.mutation(internal.googleSync.commitCalendarFullResync, {
      userId,
      googleCalendarId,
      syncGeneration: 3,
      syncToken: "new",
    });
    cal = (await readCal())!;
    expect(cal.syncGeneration).toBe(3);
    expect(cal.syncToken).toBe("new");

    // Incremental sync just advances the cursor in place.
    await t.mutation(internal.googleSync.setCalendarSyncToken, {
      userId,
      googleCalendarId,
      syncToken: "incr",
    });
    expect((await readCal())!.syncToken).toBe("incr");
  });
});
