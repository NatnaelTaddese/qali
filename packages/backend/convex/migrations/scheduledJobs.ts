import {
  makeFunctionReference,
  type SchedulableFunctionReference,
} from "convex/server";
import { v } from "convex/values";

import { internal } from "../_generated/api";
import { internalMutation, internalQuery } from "../_generated/server";

/**
 * Scheduler-queue tooling for the hard cutover that deletes the root facades
 * (MIGRATION_RUNBOOK.md section 4). Legacy `booking:expireBooking` entries are
 * queued as far out as the 365-day booking horizon, so they cannot passively
 * drain: immediately after the cutover deploy — rehearsed first on a preview
 * deployment — `migrateExpireBookingSchedules` moves every pending legacy
 * entry to its canonical path. Re-running from a null cursor is a no-op for
 * entries migrated earlier: the canceled originals fail the pending-state
 * filter and their replacements carry the new-path name. The 15-minute
 * `expirePastBookings` cron is the safety net for the window between the
 * deploy and the migration run, and for any entry the migration misses.
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

/** Rehearsal seeding for a preview deployment — must NEVER run in production,
 * where the real entries already exist and seeding would double-schedule them.
 * Snapshot export/import does not carry `_scheduled_functions`, so this
 * reconstructs prod-like scheduler state: one legacy-path
 * `booking:expireBooking` entry at `endMs` per pending booking, exactly as
 * pre-cutover `requestBooking` queued them. The deleted path is addressable
 * only by name, so the reference is built by string; the seeded entries are
 * never meant to execute — the repoint migration replaces them. */
export const seedLegacyExpireBookingJobs = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
  },
  returns: v.object({ seeded: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("bookings")
      .withIndex("by_status_and_end", (q) => q.eq("status", "pending"))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? BATCH_SIZE });
    let seeded = 0;
    const legacyExpireBooking = makeFunctionReference<"mutation">(
      "booking:expireBooking",
    );
    for (const booking of page.page) {
      await ctx.scheduler.runAt(booking.endMs, legacyExpireBooking, {
        bookingId: booking._id,
      });
      seeded += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.scheduledJobs.seedLegacyExpireBookingJobs,
        { cursor: page.continueCursor, numItems: args.numItems },
      );
    }
    return { seeded, done: page.isDone };
  },
});
