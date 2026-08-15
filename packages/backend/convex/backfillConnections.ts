/**
 * One-shot backfill for the connection model (Stage 5). Populates the tables and
 * neutral columns added in the expand from the existing Google-named data, so the
 * dual-write/cutover steps have something to read. Legacy columns are left
 * untouched — they stay the source of truth until cutover.
 *
 * Run it by hand after deploying the expand:
 *   npx convex run backfillConnections:enqueueConnectionBackfill '{}'
 *
 * Everything here is idempotent: it skips rows already carrying a connectionId
 * and connections/ledger rows that already exist, so a re-run (or a crashed run
 * that resumes) converges without duplicating. Batched + self-scheduling to stay
 * within Convex's per-mutation limits, mirroring maintenance.ts.
 */

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";

const USER_BATCH = 50;
const ROW_BATCH = 500;

/** Find or create the user's single Google connection (connection == login grant). */
async function ensureConnection(
  ctx: MutationCtx,
  userId: string,
): Promise<Id<"calendarConnections">> {
  const existing = await ctx.db
    .query("calendarConnections")
    .withIndex("by_user_and_provider", (q) =>
      q.eq("userId", userId).eq("provider", "google"),
    )
    .first();
  if (existing) return existing._id;
  const now = Date.now();
  return await ctx.db.insert("calendarConnections", {
    userId,
    provider: "google",
    status: "active",
    capabilities: { contacts: true, idempotentCreate: true },
    createdAt: now,
    updatedAt: now,
  });
}

/** Copy the user's single `syncState` row into a connection-scoped one. */
async function ensureConnectionSyncState(
  ctx: MutationCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
): Promise<void> {
  const existing = await ctx.db
    .query("connectionSyncState")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .first();
  if (existing) return;
  const legacy = await ctx.db
    .query("syncState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  await ctx.db.insert("connectionSyncState", {
    connectionId,
    userId,
    contactsCursor: legacy?.contactsSyncToken,
    otherContactsCursor: legacy?.otherContactsSyncToken,
    contactsGeneration: legacy?.contactsSyncGeneration,
    otherContactsGeneration: legacy?.otherContactsSyncGeneration,
    // A backfill must not inherit an in-flight "syncing" state; the run that owns
    // it is long gone. Its lease/attempt are copied but a stale lease is reclaimable.
    status: legacy?.status === "error" ? "error" : "idle",
    lastError: legacy?.lastError,
    nextSyncDueAt: legacy?.nextSyncDueAt,
    syncIntervalMs: legacy?.syncIntervalMs,
    syncLeaseExpiresAt: legacy?.syncLeaseExpiresAt,
    syncAttemptId: legacy?.syncAttemptId,
  });
}

/** Entry point: fan out over users (one `syncState` row each), self-continuing.
 * Users with no `syncState` (never synced) get a connection lazily on their next
 * sync, per the plan — they have no calendars/events to backfill anyway. */
export const enqueueConnectionBackfill = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("syncState")
      .paginate({ cursor: args.cursor ?? null, numItems: USER_BATCH });
    for (const state of page.page) {
      await ctx.scheduler.runAfter(0, internal.backfillConnections.backfillUser, {
        userId: state.userId,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.enqueueConnectionBackfill,
        { cursor: page.continueCursor },
      );
    }
    return null;
  },
});

/** Per user: connection + sync state + the (few) calendars, then hand off event
 * batches. */
export const backfillUser = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const connectionId = await ensureConnection(ctx, args.userId);
    await ensureConnectionSyncState(ctx, args.userId, connectionId);

    const calendars = await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const cal of calendars) {
      if (cal.connectionId) continue;
      await ctx.db.patch(cal._id, {
        connectionId,
        providerCalendarId: cal.googleCalendarId,
        syncCursor: cal.syncToken,
      });
    }

    await ctx.scheduler.runAfter(
      0,
      internal.backfillConnections.backfillUserEvents,
      { userId: args.userId, connectionId, cursor: null },
    );
    return null;
  },
});

/** Batch-patch the user's events with the neutral mirror, self-continuing until
 * the table is drained, then hand off the tail. */
export const backfillUserEvents = internalMutation({
  args: {
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: ROW_BATCH });
    for (const event of page.page) {
      if (event.connectionId) continue;
      await ctx.db.patch(event._id, {
        connectionId: args.connectionId,
        providerEventId: event.googleEventId,
        providerUpdatedMs: event.googleUpdatedMs,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.backfillUserEvents,
        { ...args, cursor: page.continueCursor },
      );
    } else {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.backfillUserTail,
        { userId: args.userId, connectionId: args.connectionId },
      );
    }
    return null;
  },
});

/** The smaller per-user tables: recurring series, bookings, and the operation
 * ledger seeded from each booking's acceptance. */
export const backfillUserTail = internalMutation({
  args: { userId: v.string(), connectionId: v.id("calendarConnections") },
  handler: async (ctx, args): Promise<null> => {
    const series = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q.eq("userId", args.userId),
      )
      .collect();
    for (const s of series) {
      if (s.connectionId) continue;
      await ctx.db.patch(s._id, {
        connectionId: args.connectionId,
        providerEventId: s.googleEventId,
      });
    }

    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_host_and_start", (q) => q.eq("hostUserId", args.userId))
      .collect();
    for (const b of bookings) {
      if (!b.connectionId) {
        await ctx.db.patch(b._id, {
          connectionId: args.connectionId,
          providerEventId: b.googleEventId,
        });
      }
      // Seed the ledger from any booking that ran an accept operation. An
      // accepted booking's create landed (succeeded); a still-pending one whose
      // response was uncertain may have (ambiguous) — a distinction the ledger
      // preserves so a future retry reconciles instead of double-booking.
      if (b.acceptOperationId) {
        const existing = await ctx.db
          .query("calendarOperations")
          .withIndex("by_connection_and_key", (q) =>
            q
              .eq("connectionId", args.connectionId)
              .eq("idempotencyKey", b.acceptOperationId!),
          )
          .first();
        if (!existing) {
          const now = Date.now();
          await ctx.db.insert("calendarOperations", {
            connectionId: args.connectionId,
            userId: args.userId,
            idempotencyKey: b.acceptOperationId,
            kind: "create",
            status: b.status === "accepted" ? "succeeded" : "ambiguous",
            providerEventId: b.googleEventId,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }
    return null;
  },
});

/**
 * Read-only parity check for the backfill. Run after it settles:
 *   npx convex run --prod backfillConnections:verifyParity '{}'
 *
 * The EXACT signal is `usersMatch`: one connection + one connectionSyncState per
 * syncState user. The per-table `lacking` counts are SAMPLED (up to `sampleLimit`,
 * default 5000) — `sampleCapped:false` means the sample covered the whole table,
 * so the count is exhaustive. A small, growing `lacking` count is expected once
 * traffic resumes: rows synced/created after the backfill won't carry the neutral
 * fields until dual-write ships. So read this right after the backfill, and judge
 * coverage against the sampled total, not against zero forever.
 */
export const verifyParity = internalQuery({
  args: { sampleLimit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const n = args.sampleLimit ?? 5000;
    const connections = await ctx.db.query("calendarConnections").collect();
    const connSync = await ctx.db.query("connectionSyncState").collect();
    const syncStates = await ctx.db.query("syncState").collect();
    const ops = await ctx.db.query("calendarOperations").collect();

    const sample = async (
      table: "events" | "calendars" | "recurringSeries" | "bookings",
    ) => {
      const rows = await ctx.db.query(table).take(n);
      const lackingConnectionId = rows.filter((r) => !r.connectionId).length;
      const idMismatch = rows.filter(
        (r) =>
          "googleEventId" in r &&
          r.googleEventId !== undefined &&
          r.providerEventId !== r.googleEventId,
      ).length;
      return {
        sampled: rows.length,
        sampleCapped: rows.length === n, // true => raise sampleLimit for exact
        lackingConnectionId,
        providerIdMismatch: idMismatch,
      };
    };

    return {
      // The exact, churn-free parity signal.
      syncStateUsers: syncStates.length,
      connections: connections.length,
      connectionSyncState: connSync.length,
      usersMatch:
        connections.length === syncStates.length &&
        connSync.length === syncStates.length,
      connectionsByProvider: connections.reduce<Record<string, number>>(
        (m, c) => ({ ...m, [c.provider]: (m[c.provider] ?? 0) + 1 }),
        {},
      ),
      calendarOperations: ops.length,
      opStatus: ops.reduce<Record<string, number>>(
        (m, o) => ({ ...m, [o.status]: (m[o.status] ?? 0) + 1 }),
        {},
      ),
      events: await sample("events"),
      calendars: await sample("calendars"),
      recurringSeries: await sample("recurringSeries"),
      bookings: await sample("bookings"),
    };
  },
});
