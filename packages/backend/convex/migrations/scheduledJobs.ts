import {
  makeFunctionReference,
  type SchedulableFunctionReference,
} from "convex/server";
import { v } from "convex/values";

import { internal } from "../_generated/api";
import { internalMutation, internalQuery } from "../_generated/server";

/**
 * Scheduler-queue tooling. A scheduled entry stores its target as a path
 * string, so renaming or deleting a scheduled function strands whatever is
 * already queued against the old spelling — and `booking:expireBooking` entries
 * sit in the queue as far out as the 365-day booking horizon, far too long to
 * drain passively. `migrateExpireBookingSchedules` cancels each pending entry
 * matched by name and reschedules it against the canonical path, preserving
 * `scheduledTime` and args. Re-running from a null cursor is a no-op for
 * entries migrated earlier: the canceled originals fail the pending-state
 * filter and their replacements carry the new-path name.
 *
 * Ran against production on 2026-08-27 for the provider cutover (765 entries
 * scanned, none pending). Kept for the next rename that moves a long-horizon
 * scheduled target: extend `SCHEDULE_MIGRATIONS` with the old-to-new pair.
 * `listPendingFunctionNames` is the standalone sweep for auditing what the
 * queue currently targets.
 */

const BATCH_SIZE = 200;

/** Real deployments store bundled module names ("booking.js:expireBooking");
 * convex-test stores source names ("booking:expireBooking"). Strip the ".js"
 * from the module part so both compare against one spelling. */
function normalizeScheduledName(name: string): string {
  const sep = name.lastIndexOf(":");
  if (sep === -1) return name;
  return name.slice(0, sep).replace(/\.js$/, "") + name.slice(sep);
}

// Long-horizon legacy targets to move, keyed by normalized scheduled name.
// Another long-horizon path is a one-line addition here.
const SCHEDULE_MIGRATIONS: { match: string; target: SchedulableFunctionReference }[] = [
  {
    match: "booking:expireBooking",
    target: internal.domains.booking.mutations.expireBooking,
  },
];

/** Cancel each pending legacy-path entry and re-schedule its canonical target
 * at the identical time with the identical args. `scanned`/`migrated` carry
 * running totals across the self-reschedule chain; start a run with neither. */
export const migrateExpireBookingSchedules = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    scanned: v.optional(v.number()),
    migrated: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    migrated: v.number(),
    done: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.system
      .query("_scheduled_functions")
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? BATCH_SIZE });
    let scanned = args.scanned ?? 0;
    let migrated = args.migrated ?? 0;
    for (const doc of page.page) {
      scanned += 1;
      if (doc.state.kind !== "pending") continue;
      const name = normalizeScheduledName(doc.name);
      const entry = SCHEDULE_MIGRATIONS.find((m) => m.match === name);
      if (!entry) continue;
      if (args.dryRun !== true) {
        await ctx.scheduler.cancel(doc._id);
        // Scheduled args are stored as a one-element array holding the
        // original args object.
        await ctx.scheduler.runAt(doc.scheduledTime, entry.target, doc.args[0]);
      }
      migrated += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.scheduledJobs.migrateExpireBookingSchedules,
        {
          cursor: page.continueCursor,
          numItems: args.numItems,
          dryRun: args.dryRun,
          scanned,
          migrated,
        },
      );
    }
    console.log(
      `migrateExpireBookingSchedules dryRun=${args.dryRun === true} ` +
        `scanned=${scanned} migrated=${migrated} done=${page.isDone}`,
    );
    return { scanned, migrated, done: page.isDone };
  },
});

/** Drain-gate sweep: pending-state scheduled-function names, counted by
 * normalized name. Scriptable — feed `continueCursor` back in until `isDone`,
 * summing counts — and run after the repoint migration: no pending name may
 * still address a deleted path. */
export const listPendingFunctionNames = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    counts: v.record(v.string(), v.number()),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.system
      .query("_scheduled_functions")
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? BATCH_SIZE });
    const counts: Record<string, number> = {};
    for (const doc of page.page) {
      if (doc.state.kind !== "pending") continue;
      const name = normalizeScheduledName(doc.name);
      counts[name] = (counts[name] ?? 0) + 1;
    }
    return { counts, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});
