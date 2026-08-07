import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

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
// forever. We keep the same horizon a first-time resync reaches back to
// (CALENDAR_HISTORY_MS = 365 days in googleSync.ts); anything older is data no
// feature reads. Fans out per user (events are indexed under userId) so each
// deletion pass uses the by_user_and_start index instead of a table scan.
const EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
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
    const cutoff = Date.now() - EVENT_RETENTION_MS;
    const rows = await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) =>
        q.eq("userId", args.userId).lt("startMs", cutoff),
      )
      .take(BATCH_SIZE);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    if (rows.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.maintenance.pruneUserEvents, {
        userId: args.userId,
      });
    }
    return null;
  },
});
