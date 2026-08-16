import { v } from "convex/values";

import { internal } from "../_generated/api";
import { isSharedPublicCalendar } from "../lib/calendars";
import { defineMutation } from "../lib/functionDefinitions";

/**
 * One-shot data migrations — run by hand once, then idle. Kept apart from the
 * recurring jobs so "things that run forever" and "things you run once" don't
 * mix. Registered at `internal.maintenance.*` through the root facade (the path
 * their self-reschedules already reference); the connection-model backfill lives
 * separately in backfillConnections.ts.
 */

const BATCH_SIZE = 500;

// --- Drop the orphaned `eventAttendees` table ------------------------------
// Left behind by the move to the unified `people` directory. Absent from
// schema.ts and read by nothing; clearing every row makes Convex drop the table.
// `as any` is deliberate: the table is not in the data model — that is the point.
export const clearEventAttendees = defineMutation({
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
      await ctx.scheduler.runAfter(
        0,
        internal.maintenance.clearEventAttendees,
        {},
      );
    }
    return { deleted: rows.length, done };
  },
});

// --- Migrate existing per-user public-calendar events to shared ------------
// Deletes every per-user copy of a Google public calendar's events (they now
// live once in `sharedEvents`), then kicks each user's sync so the shared copy
// is populated promptly rather than only on the next 15-min cron tick.
export const migratePublicCalendarsToShared = defineMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args): Promise<{ deleted: number; done: boolean }> => {
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

// --- Purge sharedEvents no longer classified as shared ---------------------
// The `isSharedPublicCalendar` allowlist was narrowed to holiday calendars only.
// Delete every sharedEvents row whose calendar no longer classifies as shared,
// then fan out a sync so those events are re-fetched into each owner's per-user
// `events` table (guarded by ownership).
export const purgeNonSharedSharedEvents = defineMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, args): Promise<{ deleted: number; done: boolean }> => {
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
    // Final page: fan out a sync so purged birthday/secondary events are
    // re-synced into their owners' per-user `events` promptly.
    for await (const state of ctx.db.query("syncState")) {
      await ctx.scheduler.runAfter(0, internal.googleSync.syncUser, {
        userId: state.userId,
      });
    }
    return { deleted, done: true };
  },
});
