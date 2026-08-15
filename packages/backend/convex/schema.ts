import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { assistantTables } from "./domains/assistant/tables";
import { bookingTables } from "./domains/booking/tables";
import { calendarTables } from "./domains/calendar/tables";
import { marketingTables } from "./domains/marketing/tables";
import { notificationTables } from "./domains/notifications/tables";
import { peopleTables } from "./domains/people/tables";

// The event validators (attendee/person/googleEvent/eventDoc) live in
// domains/calendar/validators.ts so the schema and the calendar write path can
// share them without a circular import back through this file.

// assistantBlockValidator lives in domains/assistant/validators.ts.

export default defineSchema({
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
    // cron-scheduled run, and a workspace-mount sync for the same user cannot
    // overlap and race each other's token updates. Released in recordSyncOutcome;
    // a stale lease past its expiry can be reclaimed. See runSyncForUser.
    syncLeaseExpiresAt: v.optional(v.number()),
    syncAttemptId: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_nextSyncDueAt", ["nextSyncDueAt"]),

  // Calendar domain tables — calendars / events / sharedEvents / sharedCalendars /
  // recurringSeries (see domains/calendar/tables.ts).
  ...calendarTables,

  // Booking domain tables — pages, date overrides, requests (see
  // domains/booking/tables.ts).
  ...bookingTables,

  // Notifications domain tables (see domains/notifications/tables.ts).
  ...notificationTables,

  // Fixed-window counters guarding the one mutation anonymous callers can
  // reach. Keyed by requester email and by page slug — a Convex mutation has no
  // client IP to key on.
  bookingRateLimits: defineTable({
    key: v.string(),
    windowStartMs: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),

  // People domain tables — contacts feed + unified directory (see
  // domains/people/tables.ts).
  ...peopleTables,

  // --- AI assistant ---------------------------------------------------------
  // These tables stay empty when no DEEPSEEK_API_KEY is configured; the
  // assistant is optional and its absence must not change anything else.

  // Assistant domain tables — threads / state / messages / actions (see
  // domains/assistant/tables.ts).
  ...assistantTables,

  // Marketing domain tables — the public waitlist (see domains/marketing/tables.ts).
  ...marketingTables,

  // --- Provider-ready connection model (Stage 5 "expand") -----------------
  // These three tables are additive and, for now, written/read by nothing: they
  // are deployed empty so the later backfill can populate them before any code
  // depends on them. Legacy Google-named columns on the tables above stay the
  // source of truth until the cutover; these are their provider-neutral future.

  // One row per connected provider account for a user. v1 backfills exactly one
  // Google connection per existing user (connection == the login grant), so the
  // credential is still resolved through Better Auth, not stored here.
  calendarConnections: defineTable({
    userId: v.string(),
    provider: v.union(v.literal("google"), v.literal("microsoft")),
    // The provider account identity (email / tenant), when known. Absent for a
    // backfilled login-grant connection until a sync learns it.
    providerAccountId: v.optional(v.string()),
    // How the credential broker finds this connection's token (v1: the Better
    // Auth account id). No secret or refresh token lives in app tables.
    credentialRef: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("error"),
    ),
    // Mirrors the adapter's ProviderCapabilities so a service can gate optional
    // features (contacts, idempotent create) without instantiating the adapter.
    capabilities: v.optional(
      v.object({
        contacts: v.boolean(),
        idempotentCreate: v.boolean(),
      }),
    ),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_provider", ["userId", "provider"]),

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
    contactsGeneration: v.optional(v.number()),
    otherContactsGeneration: v.optional(v.number()),
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

  // Provider-neutral operation ledger (Interface Risk #1). A write claims a row
  // keyed by its app-minted idempotency key before touching the provider, so a
  // retry after an ambiguous failure reconciles against `status`/provider ids
  // instead of relying on a Google-compatible event id. Generalizes the current
  // acceptOperationId / googleEventIdForOperation trick to every provider.
  calendarOperations: defineTable({
    connectionId: v.id("calendarConnections"),
    userId: v.string(),
    // Stable across retries of one logical write; the adapter maps it to the
    // provider's native dedup (Google client-assigned id, Graph transactionId).
    idempotencyKey: v.string(),
    kind: v.union(
      v.literal("create"),
      v.literal("update"),
      v.literal("delete"),
      v.literal("respond"),
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("ambiguous"),
      v.literal("failed"),
    ),
    providerCalendarId: v.optional(v.string()),
    providerEventId: v.optional(v.string()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_connection_and_key", ["connectionId", "idempotencyKey"])
    .index("by_user_and_status", ["userId", "status"]),
});
