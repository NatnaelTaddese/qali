import { v } from "convex/values";

import { internal } from "../_generated/api";
import type { Id, TableNames } from "../_generated/dataModel";
import { defineMutation } from "../shared/functionDefinitions";

/**
 * Recurring storage maintenance + the account-deletion purge. All internal,
 * self-rescheduling in bounded batches so a run stays under Convex's
 * per-mutation write limits. Registered at `internal.maintenance.*` through the
 * root facade, which is the path crons and self-reschedules reference.
 */

const BATCH_SIZE = 500;
const USER_FANOUT_BATCH = 50;

// --- Recurring: prune events that have aged out of the sync window ---------
// We keep the same 180-day horizon a first-time resync reaches back to
// (CALENDAR_HISTORY_MS in the sync engine); anything older is data no feature
// reads. Fans out per user so each pass uses the by_user_and_start index.
const EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
// Symmetric forward horizon (matches CALENDAR_FUTURE_MS). Prune uses prune-time
// `now`, which only advances, so it never trims events a fresh sync just fetched.
const EVENT_FUTURE_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export const enqueueEventPrune = defineMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("userSyncState")
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

export const pruneUserEvents = defineMutation({
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
export const enqueueSharedEventPrune = defineMutation({
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
        {
          provider: row.provider ?? "google",
          providerCalendarId: row.providerCalendarId ?? row.googleCalendarId,
        },
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

export const pruneSharedCalendarEvents = defineMutation({
  args: {
    provider: v.union(v.literal("google"), v.literal("microsoft")),
    providerCalendarId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const past = await ctx.db
      .query("sharedEvents")
      .withIndex("by_provider_and_providerCalendarId_and_startMs", (q) =>
        q
          .eq("provider", args.provider)
          .eq("providerCalendarId", args.providerCalendarId)
          .lt("startMs", now - EVENT_RETENTION_MS),
      )
      .take(BATCH_SIZE);
    for (const row of past) {
      await ctx.db.delete(row._id);
    }
    if (past.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance.pruneSharedCalendarEvents,
        args,
      );
      return null;
    }
    const future = await ctx.db
      .query("sharedEvents")
      .withIndex("by_provider_and_providerCalendarId_and_startMs", (q) =>
        q
          .eq("provider", args.provider)
          .eq("providerCalendarId", args.providerCalendarId)
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
        args,
      );
    }
    return null;
  },
});

// --- Recurring: prune stale rate-limit counters ----------------------------
// Drop `bookingRateLimits` rows untouched for a day — well past any active
// window, so a later request for that key just re-inserts a fresh counter.
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

export const pruneRateLimits = defineMutation({
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

// --- Account deletion: erase all of a user's data ---------------------------
// The cleanup primitive to run when an account goes away, so no per-user PII
// outlives it. Bounded batches per user-scoped table, self-rescheduling until
// empty; safe to re-run. Passing the account `email` also clears its waitlist row.
const PURGE_BATCH = 100;

export const purgeUserData = defineMutation({
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
        | "userSyncState"
        | "connectionSyncState"
        | "calendarConnections"
        | "connectionBackfillUsers"
        | "calendars"
        | "bookingPages"
        | "contacts"
        | "otherContactSources"
        | "personSourceClaims"
        | "people"
        | "assistantUserState"
        | "assistantMessages",
    ) =>
      ctx.db
        .query(table)
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH);

    await drain(await byUser("syncState"));
    await drain(await byUser("userSyncState"));
    // Delete connection children before their parent connection rows. Convex
    // does not enforce foreign keys, but this ordering prevents retries from
    // observing orphaned operational state midway through a batched purge.
    await drain(
      await ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH),
    );
    await drain(await byUser("connectionSyncState"));
    await drain(await byUser("connectionBackfillUsers"));
    await drain(await byUser("calendars"));
    await drain(await byUser("bookingPages"));
    await drain(await byUser("contacts"));
    await drain(await byUser("otherContactSources"));
    await drain(await byUser("personSourceClaims"));
    await drain(await byUser("people"));
    await drain(await byUser("assistantUserState"));
    await drain(await byUser("assistantMessages"));
    // Parent connections are removed only after every child table has drained;
    // retries therefore never strand connection-owned claims or sync state.
    if (!more) await drain(await byUser("calendarConnections"));
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
