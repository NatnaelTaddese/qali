import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Table definitions owned by sync orchestration, composed into schema.ts. */
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
    engagementGeneration: v.optional(v.number()),
    engagementAttemptId: v.optional(v.string()),
    engagementLeaseExpiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
