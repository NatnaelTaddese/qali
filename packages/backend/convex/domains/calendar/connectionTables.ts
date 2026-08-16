import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Provider-ready connection tables owned by the calendar domain. */
export const calendarConnectionTables = {
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
};

export const calendarOperationTables = {
  // Provider-neutral operation ledger (Interface Risk #1). A write claims a row
  // keyed by its app-minted idempotency key before touching the provider, so a
  // retry after an ambiguous failure reconciles against `status`/provider ids
  // instead of relying on a Google-compatible event id.
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
    bookingId: v.optional(v.id("bookings")),
    attemptId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    mayHaveSucceeded: v.optional(v.boolean()),
    localCalendarId: v.optional(v.id("calendars")),
    providerCalendarId: v.optional(v.string()),
    targetEventId: v.optional(v.id("events")),
    targetProviderEventId: v.optional(v.string()),
    requestFingerprint: v.optional(v.string()),
    providerEventId: v.optional(v.string()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_connection_and_key", ["connectionId", "idempotencyKey"])
    .index("by_bookingId", ["bookingId"])
    .index("by_user_and_status", ["userId", "status"]),

  // Durable deduplication/progress for the resumable connection backfill.
  connectionBackfillUsers: defineTable({
    userId: v.string(),
    runId: v.string(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),
};
