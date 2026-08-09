import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import { v } from "convex/values";

import { isSharedPublicCalendar } from "./lib/calendars";

// Storage maintenance: one-shot cleanups and the recurring prune that keeps
// the `events` table from growing without bound. All mutations here are
// internal — never reachable from a client — and self-reschedule in batches so
// a single run always stays under Convex's per-mutation write limits.

const BATCH_SIZE = 500;

// --- One-shot: drop the orphaned `eventAttendees` table --------------------
// Left behind by the move to the unified `people` directory. It is absent from
// schema.ts and read by nothing, yet was the single largest table on disk.
// Clearing every row makes Convex drop the (schema-less) table entirely.
// `as any` is deliberate: the table is not in the generated data model, so the
// name cannot be expressed type-safely — that is the whole reason it is dead.
export const clearEventAttendees = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx): Promise<{ deleted: number; done: boolean }> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (ctx.db.query as any)("eventAttendees").take(BATCH_SIZE);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    const done = rows.length < BATCH_SIZE;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.maintenance.clearEventAttendees, {});
    }
    return { deleted: rows.length, done };
  },
});

// --- Recurring: prune events that have aged out of the sync window ---------
// Incremental sync is unbounded, so without this past events accumulate
// forever. We keep the same 180-day horizon a first-time resync reaches back to
// (CALENDAR_HISTORY_MS in googleSync.ts); anything older is data no feature
// reads. Fans out per user (events are indexed under userId) so each deletion
// pass uses the by_user_and_start index instead of a table scan.
const EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
// Symmetric forward horizon: a full resync now stops fetching past
// now + CALENDAR_FUTURE_MS (googleSync.ts), so anything beyond this is drift from
// before that bound existed, or from incremental expansion of an open-ended
// recurring series. Matches CALENDAR_FUTURE_MS. Prune uses prune-time `now`,
// which only ever advances, so it never trims events a fresh sync just fetched.
const EVENT_FUTURE_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const USER_FANOUT_BATCH = 50;

export const enqueueEventPrune = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("syncState")
      .paginate({ cursor: args.cursor ?? null, numItems: USER_FANOUT_BATCH });
    for (const row of page.page) {
      await ctx.scheduler.runAfter(0, internal.maintenance.pruneUserEvents, {
        userId: row.userId,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.maintenance.enqueueEventPrune, {
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

export const pruneUserEvents = internalMutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const past = await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) =>
        q.eq("userId", args.userId).lt("startMs", now - EVENT_RETENTION_MS),
      )
      .take(BATCH_SIZE);
    for (const row of past) {
      await ctx.db.delete(row._id);
    }
    if (past.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.maintenance.pruneUserEvents, {
        userId: args.userId,
      });
      return null;
    }
    // Past drained — trim far-future instances beyond the sync horizon.
    const future = await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) =>
        q.eq("userId", args.userId).gt("startMs", now + EVENT_FUTURE_RETENTION_MS),
      )
      .take(BATCH_SIZE);
    for (const row of future) {
      await ctx.db.delete(row._id);
    }
    if (future.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.maintenance.pruneUserEvents, {
        userId: args.userId,
      });
    }
    return null;
  },
});

// --- Recurring: prune the shared public-calendar table the same way ---------
// `sharedEvents` is user-independent (one copy of each holiday/birthday), so it
// fans out per shared calendar and prunes via the by_calendar_and_start index.

export const enqueueSharedEventPrune = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("sharedCalendars")
      .paginate({ cursor: args.cursor ?? null, numItems: USER_FANOUT_BATCH });
    for (const row of page.page) {
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance.pruneSharedCalendarEvents,
        { calendarId: row.googleCalendarId },
      );
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance.enqueueSharedEventPrune,
        { cursor: page.continueCursor },
      );
    }
    return null;
  },
});

export const pruneSharedCalendarEvents = internalMutation({
  args: { calendarId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const past = await ctx.db
      .query("sharedEvents")
      .withIndex("by_calendar_and_start", (q) =>
        q.eq("calendarId", args.calendarId).lt("startMs", now - EVENT_RETENTION_MS),
      )
      .take(BATCH_SIZE);
    for (const row of past) {
      await ctx.db.delete(row._id);
    }
    if (past.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance.pruneSharedCalendarEvents,
        { calendarId: args.calendarId },
      );
      return null;
    }
    const future = await ctx.db
      .query("sharedEvents")
      .withIndex("by_calendar_and_start", (q) =>
        q
          .eq("calendarId", args.calendarId)
          .gt("startMs", now + EVENT_FUTURE_RETENTION_MS),
      )
      .take(BATCH_SIZE);
    for (const row of future) {
      await ctx.db.delete(row._id);
    }
    if (future.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance.pruneSharedCalendarEvents,
        { calendarId: args.calendarId },
      );
    }
    return null;
  },
});

// --- Recurring: prune stale rate-limit counters ----------------------------
// The `bookingRateLimits` table gains one row per distinct key (email/page slug,
// waitlist keys). Once a key's window has long elapsed its row is dead weight, so
// drop rows untouched for a day — well past any active window, so a later request
// for that key just re-inserts a fresh counter.
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

export const pruneRateLimits = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const cutoff = Date.now() - RATE_LIMIT_RETENTION_MS;
    const page = await ctx.db
      .query("bookingRateLimits")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    for (const row of page.page) {
      if (row.windowStartMs < cutoff) {
        await ctx.db.delete(row._id);
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.maintenance.pruneRateLimits, {
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

// --- One-shot: migrate existing per-user public-calendar events to shared ---
// Deletes every per-user copy of a Google public calendar's events (they now
// live once in `sharedEvents`), then kicks each user's sync so the shared copy
// is populated promptly rather than only on the next 15-min cron tick.
export const migratePublicCalendarsToShared = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ deleted: number; done: boolean }> => {
    const page = await ctx.db
      .query("events")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    let deleted = 0;
    for (const row of page.page) {
      if (isSharedPublicCalendar(row.calendarId)) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance.migratePublicCalendarsToShared,
        { cursor: page.continueCursor },
      );
      return { deleted, done: false };
    }
    // Final page: fan out a sync for every user so `sharedEvents` fills in now.
    for await (const state of ctx.db.query("syncState")) {
      await ctx.scheduler.runAfter(0, internal.googleSync.syncUser, {
        userId: state.userId,
      });
    }
    return { deleted, done: true };
  },
});

// --- One-shot: purge sharedEvents that are no longer classified as shared ---
// The `isSharedPublicCalendar` allowlist was narrowed to holiday calendars only.
// Personalized calendars that previously matched the broad
// `@group.v.calendar.google.com` suffix — most importantly birthday
// (`#contacts@...`) calendars, but also user-created secondary calendars — had
// their events written into the userless `sharedEvents` table, from where they
// could be served to other users. Delete every sharedEvents row whose calendar
// no longer classifies as shared, then fan out a sync so those events are
// re-fetched into each owner's per-user `events` table (guarded by ownership).
export const purgeNonSharedSharedEvents = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ deleted: number; done: boolean }> => {
    const page = await ctx.db
      .query("sharedEvents")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    let deleted = 0;
    for (const row of page.page) {
      if (!isSharedPublicCalendar(row.calendarId)) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance.purgeNonSharedSharedEvents,
        { cursor: page.continueCursor },
      );
      return { deleted, done: false };
    }
    // Final page: fan out a sync for every user so the purged birthday/secondary
    // events are re-synced into their owners' per-user `events` promptly.
    for await (const state of ctx.db.query("syncState")) {
      await ctx.scheduler.runAfter(0, internal.googleSync.syncUser, {
        userId: state.userId,
      });
    }
    return { deleted, done: true };
  },
});

// --- Account deletion: erase all of a user's data ---------------------------
// The cleanup primitive to run when an account goes away, so no per-user PII
// outlives it. Invoke it by hand (dashboard/CLI) with the user's id, or wire it
// to the Better Auth user-delete trigger later — it takes only a userId (+ the
// account email) and is safe to re-run. Each call deletes a bounded batch from
// every user-scoped table and reschedules itself until all are empty; deletes
// shrink the indexes, so repeated `.take` batches always make progress and the
// run terminates. Passing the account's `email` also clears its marketing
// waitlist row, which is keyed by email rather than userId.
const PURGE_BATCH = 100;

export const purgeUserData = internalMutation({
  args: { userId: v.string(), email: v.optional(v.string()) },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, args): Promise<{ done: boolean }> => {
    const userId = args.userId;
    let more = false;
    const drain = async (rows: { _id: Id<TableNames> }[]): Promise<void> => {
      for (const row of rows) {
        await ctx.db.delete(row._id);
      }
      if (rows.length === PURGE_BATCH) {
        more = true;
      }
    };
    const byUser = (
      table:
        | "syncState"
        | "calendars"
        | "bookingPages"
        | "contacts"
        | "people"
        | "assistantUserState"
        | "assistantMessages",
    ) =>
      ctx.db
        .query(table)
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH);

    await drain(await byUser("syncState"));
    await drain(await byUser("calendars"));
    await drain(await byUser("bookingPages"));
    await drain(await byUser("contacts"));
    await drain(await byUser("people"));
    await drain(await byUser("assistantUserState"));
    await drain(await byUser("assistantMessages"));
    await drain(
      await ctx.db
        .query("events")
        .withIndex("by_user_and_start", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
    );
    await drain(
      await ctx.db
        .query("recurringSeries")
        .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
          q.eq("userId", userId),
        )
        .take(PURGE_BATCH),
    );
    await drain(
      await ctx.db
        .query("availabilityOverrides")
        .withIndex("by_user_and_date", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
    );
    await drain(
      await ctx.db
        .query("notifications")
        .withIndex("by_user_and_created", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
    );
    await drain(
      await ctx.db
        .query("assistantThreads")
        .withIndex("by_user_and_lastMessage", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
    );
    await drain(
      await ctx.db
        .query("assistantActions")
        .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
    );
    await drain(
      await ctx.db
        .query("bookings")
        .withIndex("by_host_and_start", (q) => q.eq("hostUserId", userId))
        .take(PURGE_BATCH),
    );

    // Waitlist is keyed by email, and holds at most one row per address.
    if (args.email) {
      const email = args.email.trim().toLowerCase();
      const row = await ctx.db
        .query("waitlist")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique();
      if (row) {
        await ctx.db.delete(row._id);
      }
    }

    if (more) {
      // Waitlist is one row and already handled, so don't pass email again.
      await ctx.scheduler.runAfter(0, internal.maintenance.purgeUserData, {
        userId,
      });
      return { done: false };
    }
    return { done: true };
  },
});
