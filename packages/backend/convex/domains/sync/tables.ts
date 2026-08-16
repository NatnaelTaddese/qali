import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Table definitions owned by sync orchestration, composed into schema.ts. */
export const syncTables = {
  // One row per user tracking incremental-sync state for Google data.
  // Per-calendar sync tokens live on the `calendars` table.
  syncState: defineTable({
    userId: v.string(),
    contactsSyncToken: v.optional(v.string()),
    lastContactsSyncAt: v.optional(v.number()),
    // Incremental sync token for the People API "Other contacts" list — the
    // auto-collected addresses that back avatars for people the user has only
    // interacted with, never saved. Tracked separately from contactsSyncToken.
    otherContactsSyncToken: v.optional(v.string()),
    lastOtherContactsSyncAt: v.optional(v.number()),
    // Full-resync reconcile generations for the two contact feeders. A full
    // resync stamps every re-fetched record with a fresh generation, then removes
    // records still carrying an older one — so a contact deleted while the sync
    // token was expired (People API returns no tombstone for it) is reconciled
    // away instead of lingering. See syncContacts / syncOtherContacts.
    contactsSyncGeneration: v.optional(v.number()),
    otherContactsSyncGeneration: v.optional(v.number()),
    status: v.union(
      v.literal("idle"),
      v.literal("syncing"),
      v.literal("error"),
    ),
    lastError: v.optional(v.string()),
    // Adaptive background-sync cadence. The 15-min cron only enqueues users whose
    // `nextSyncDueAt` has passed; a run that finds no changes doubles the
    // interval (up to a cap), and any change — or a user-initiated syncNow —
    // resets it to the floor. Idle users (app closed) thus poll Google far less,
    // while an open app stays fresh because it calls syncNow directly.
    nextSyncDueAt: v.optional(v.number()),
    syncIntervalMs: v.optional(v.number()),
    // A run claims this lease before touching Google, so a manual `syncNow`, a
    // cron-scheduled run, and a workspace-mount sync for the same user could not
    // overlap. These legacy lease fields remain only through storage contraction;
    // active leases now live on `connectionSyncState`.
    syncLeaseExpiresAt: v.optional(v.number()),
    syncAttemptId: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_nextSyncDueAt", ["nextSyncDueAt"]),
};

export const connectionSyncTables = {
  // Connection-scoped sync bookkeeping — the per-connection successor to the
  // single Google `syncState` row. Holds the user's OWN calendars' + contacts'
  // opaque cursors, reconcile generations, adaptive cadence, and the run lease.
  // Shared public calendars stay a global concern (sharedCalendars), never here.
  connectionSyncState: defineTable({
    connectionId: v.id("calendarConnections"),
    userId: v.string(),
    // Opaque provider cursors (Google sync tokens / Graph delta links) for the
    // two contacts feeders. Per-calendar event cursors live on `calendars`.
    contactsCursor: v.optional(v.string()),
    otherContactsCursor: v.optional(v.string()),
    contactsLastSyncedAt: v.optional(v.number()),
    otherContactsLastSyncedAt: v.optional(v.number()),
    contactsGeneration: v.optional(v.number()),
    otherContactsGeneration: v.optional(v.number()),
    contactsGenerationAttemptId: v.optional(v.string()),
    otherContactsGenerationAttemptId: v.optional(v.string()),
    // Legacy Other Contacts stored no provider row identity. Backfill clears the
    // cursor and sets this gate until a complete provider snapshot materializes
    // `otherContactSources` and exact claims.
    otherContactsBackfillRequired: v.optional(v.boolean()),
    status: v.union(
      v.literal("idle"),
      v.literal("syncing"),
      v.literal("error"),
    ),
    lastError: v.optional(v.string()),
    nextSyncDueAt: v.optional(v.number()),
    syncIntervalMs: v.optional(v.number()),
    syncLeaseExpiresAt: v.optional(v.number()),
    syncAttemptId: v.optional(v.string()),
  })
    .index("by_connection", ["connectionId"])
    .index("by_user", ["userId"])
    .index("by_nextSyncDueAt", ["nextSyncDueAt"]),

  // One stable row per user for work that intentionally spans every calendar
  // connection. Connection polling never reads this row.
  userSyncState: defineTable({
    userId: v.string(),
    engagementDirty: v.boolean(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
