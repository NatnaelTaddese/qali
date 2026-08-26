import { v } from "convex/values";

import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";

/**
 * One-shot provider-model cutover, run once between deploy A (transitional
 * schema) and deploy B (final schema):
 *
 *   npx convex run migrations/providerCutover:start '{}'
 *
 * Expires in-flight assistant proposals, nulls every cross-table reference
 * into the derived provider tables, wipes those tables, then fans out one
 * sync per user to rebuild them provider-neutrally. Deploy B's schema
 * validation is the completion gate: it fails if any retained row still
 * carries a legacy column, and the fix is re-running the relevant clear
 * phase — never forcing the push.
 *
 * Every phase is cursor-paginated, self-rescheduling, and idempotent, so a
 * failed phase is resumed in place. Never restart from `start` once
 * `fanOutResync` has run: a full re-run re-nulls freshly re-pointed booking
 * targets and re-wipes synced data — self-healing, but wasteful.
 *
 * Deleted (with its itest) at the final schema: it references
 * transitional-only columns and the `syncState`/`connectionBackfillUsers`
 * tables that deploy B drops, and by then it has served its purpose.
 */

const BATCH_SIZE = 500;

// Sentinel lease stamped on every connection for the duration of the wipe, so
// neither the 15-min cron nor a user's syncNow can claim a connection and
// interleave a sync mid-wipe (which would strand events keyed to wiped
// calendar ids). `fanOutResync` releases it; the expiry backstops a lost run.
const CUTOVER_ATTEMPT_ID = "cutover";
const CUTOVER_LEASE_MS = 15 * 60 * 1000;

// --- Phase 1: expire in-flight assistant proposals -------------------------
// `applying` too: such a row holds an apply lease against an event the wipe
// removes. The schema has no "expired" literal, so `failed` + a summary is the
// terminal state the panel already renders.
export const expireAssistantActions = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("assistantActions")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    for (const row of page.page) {
      if (row.status !== "pending" && row.status !== "applying") continue;
      await ctx.db.patch(row._id, {
        status: "failed",
        resultSummary:
          "Superseded by the provider-model cutover; please re-ask.",
        decidedAt: Date.now(),
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.providerCutover.expireAssistantActions,
        { cursor: page.continueCursor },
      );
      return null;
    }
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.providerCutover.clearBookingTargets,
      {},
    );
    return null;
  },
});

// --- Phase 2: null booking references into wiped tables --------------------
// Targets are unset as a PAIR — resolution throws when exactly one is present.
// `acceptOperationId` (the stable idempotency key), `connectionId`,
// `providerEventId`, `status`, and `decidedAt` survive; terminal bookings
// never re-resolve and pending acceptances re-resolve through the ledger.
export const clearBookingTargets = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("bookings")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    for (const row of page.page) {
      await ctx.db.patch(row._id, {
        googleEventId: undefined,
        calendarId: undefined,
        targetConnectionId: undefined,
        targetCalendarId: undefined,
        acceptAttemptId: undefined,
        acceptLeaseExpiresAt: undefined,
        acceptMayHaveSucceeded: undefined,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.providerCutover.clearBookingTargets,
        { cursor: page.continueCursor },
      );
      return null;
    }
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.providerCutover.clearBookingPageTargets,
      {},
    );
    return null;
  },
});

// --- Phase 3: null booking-page targets (pairwise, see phase 2) ------------
// The primary-target fallback self-heals each page after the resync.
export const clearBookingPageTargets = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("bookingPages")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    for (const row of page.page) {
      await ctx.db.patch(row._id, {
        targetConnectionId: undefined,
        targetCalendarId: undefined,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.providerCutover.clearBookingPageTargets,
        { cursor: page.continueCursor },
      );
      return null;
    }
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.providerCutover.clearCalendarOperationRefs,
      {},
    );
    return null;
  },
});

// --- Phase 4: null operation-ledger refs into wiped tables -----------------
// The string columns (`providerCalendarId`, `providerEventId`) carry identity
// across the wipe and survive; a retried claim adopts the caller's fresh
// `localCalendarId` in place of the nulled one.
export const clearCalendarOperationRefs = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("calendarOperations")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    for (const row of page.page) {
      await ctx.db.patch(row._id, {
        localCalendarId: undefined,
        targetEventId: undefined,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.providerCutover.clearCalendarOperationRefs,
        { cursor: page.continueCursor },
      );
      return null;
    }
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.providerCutover.resetConnectionSyncState,
      {},
    );
    return null;
  },
});

// --- Phase 5: reset sync bookkeeping under the wipe sentinel ---------------
// Cursors and generations describe wiped data, so they are cleared; the
// sentinel lease (not a cleared one) is stamped so no sync can claim the
// connection until `fanOutResync` releases it. `nextSyncDueAt = now` makes the
// cron the backup path if the fan-out itself is lost.
export const resetConnectionSyncState = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    if (args.cursor === undefined || args.cursor === null) {
      // userSyncState is one row per user — a full inline pass on the first
      // page. Never wiped: it enumerates the resync fan-out itself.
      for await (const state of ctx.db.query("userSyncState")) {
        await ctx.db.patch(state._id, {
          engagementDirty: true,
          engagementAttemptId: undefined,
          engagementLeaseExpiresAt: undefined,
        });
      }
    }
    const page = await ctx.db
      .query("connectionSyncState")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    for (const row of page.page) {
      await ctx.db.patch(row._id, {
        contactsCursor: undefined,
        otherContactsCursor: undefined,
        contactsLastSyncedAt: undefined,
        otherContactsLastSyncedAt: undefined,
        contactsGeneration: undefined,
        otherContactsGeneration: undefined,
        contactsGenerationAttemptId: undefined,
        otherContactsGenerationAttemptId: undefined,
        otherContactsBackfillRequired: undefined,
        syncAttemptId: CUTOVER_ATTEMPT_ID,
        syncLeaseExpiresAt: now + CUTOVER_LEASE_MS,
        lastError: undefined,
        syncIntervalMs: undefined,
        status: "idle",
        nextSyncDueAt: now,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.providerCutover.resetConnectionSyncState,
        { cursor: page.continueCursor },
      );
      return null;
    }
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.providerCutover.wipeDerivedTables,
      { table: WIPE_TABLES[0] },
    );
    return null;
  },
});

// --- Phase 6: wipe every derived provider table ----------------------------
// All of these are rebuilt from the provider by the resync (or, for the two
// legacy tables at the end, deleted outright at the final schema). Preserved
// on purpose: calendarConnections, connectionSyncState, userSyncState,
// bookings, bookingPages, calendarOperations, and everything user-authored.
const WIPE_TABLES = [
  "events",
  "recurringSeries",
  "calendars",
  "sharedCalendars",
  "sharedEvents",
  "contacts",
  "people",
  "personSourceClaims",
  "otherContactSources",
  "connectionBackfillUsers",
  "syncState",
] as const;

const wipeTableValidator = v.union(
  v.literal("events"),
  v.literal("recurringSeries"),
  v.literal("calendars"),
  v.literal("sharedCalendars"),
  v.literal("sharedEvents"),
  v.literal("contacts"),
  v.literal("people"),
  v.literal("personSourceClaims"),
  v.literal("otherContactSources"),
  v.literal("connectionBackfillUsers"),
  v.literal("syncState"),
);

export const wipeDerivedTables = internalMutation({
  args: {
    table: wipeTableValidator,
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query(args.table)
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    for (const row of page.page) {
      await ctx.db.delete(row._id);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.providerCutover.wipeDerivedTables,
        { table: args.table, cursor: page.continueCursor },
      );
      return null;
    }
    const next = WIPE_TABLES[WIPE_TABLES.indexOf(args.table) + 1];
    if (next) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.providerCutover.wipeDerivedTables,
        { table: next },
      );
      return null;
    }
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.providerCutover.drainEventAttendees,
      {},
    );
    return null;
  },
});

// --- Phase 7: drain the orphaned `eventAttendees` table --------------------
// Left behind by the move to the unified `people` directory; absent from the
// schema and read by nothing — deleting every row makes Convex drop the table.
// `as any` is deliberate: the table is not in the data model, which is the point.
export const drainEventAttendees = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (ctx.db.query as any)("eventAttendees").take(BATCH_SIZE);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    if (rows.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.providerCutover.drainEventAttendees,
        {},
      );
      return null;
    }
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.providerCutover.fanOutResync,
      {},
    );
    return null;
  },
});

// --- Phase 8: release the sentinel, then resync every user -----------------
export const fanOutResync = internalMutation({
  args: {},
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx): Promise<{ done: boolean }> => {
    // Release only our own sentinel — a re-run after real syncs have started
    // must not clear a live lease a running sync holds.
    for await (const state of ctx.db.query("connectionSyncState")) {
      if (state.syncAttemptId !== CUTOVER_ATTEMPT_ID) continue;
      await ctx.db.patch(state._id, {
        syncAttemptId: undefined,
        syncLeaseExpiresAt: undefined,
      });
    }
    for await (const state of ctx.db.query("userSyncState")) {
      await ctx.scheduler.runAfter(0, internal.domains.sync.engine.syncUser, {
        userId: state.userId,
      });
    }
    console.log("providerCutover: fan-out complete — cutover done");
    return { done: true };
  },
});

// --- Entry point -----------------------------------------------------------
export const start = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    console.log("providerCutover: starting phase chain");
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.providerCutover.expireAssistantActions,
      {},
    );
    return null;
  },
});
