import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { bookingTables } from "./domains/booking/tables";
import { calendarTables } from "./domains/calendar/tables";
import { marketingTables } from "./domains/marketing/tables";
import { notificationTables } from "./domains/notifications/tables";
import { peopleTables } from "./domains/people/tables";

// The event validators (attendee/person/googleEvent/eventDoc) live in
// domains/calendar/validators.ts so the schema and the calendar write path can
// share them without a circular import back through this file.

/** One piece of an assistant turn, in the order it happened.
 *
 * A turn is a list of these rather than a string because a single reply can
 * interleave prose with tool activity, and the panel renders each kind
 * differently. The action appends to the list as the model streams, so the same
 * shape has to survive a half-finished turn.
 *
 * `tool_call` and `tool_result` are also what the next request's history is
 * rebuilt from, so they hold exactly what the model needs to see: the raw
 * argument JSON as it arrived, never a re-serialized version of it.
 *
 * `proposal` is the odd one out — it carries nothing for the model, only the id
 * of the `assistantActions` row the panel renders a confirm card for. */
export const assistantBlockValidator = v.union(
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({
    type: v.literal("tool_call"),
    toolCallId: v.string(),
    name: v.string(),
    // The model's own JSON string. Kept verbatim: re-encoding it would change
    // the bytes the model sees when this turn is replayed as history.
    arguments: v.string(),
  }),
  v.object({
    type: v.literal("tool_result"),
    toolCallId: v.string(),
    content: v.string(),
    isError: v.optional(v.boolean()),
  }),
  v.object({
    type: v.literal("proposal"),
    toolCallId: v.string(),
    actionId: v.id("assistantActions"),
  }),
);

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

  // One conversation. `lastMessageAt` rather than `_creationTime` orders the
  // list, so a revived old thread sorts to the top where the user left it.
  assistantThreads: defineTable({
    userId: v.string(),
    title: v.string(),
    createdAt: v.number(),
    lastMessageAt: v.number(),
    // Transactional per-thread turn claim. Cleared by finish/fail; stale claims
    // are recovered against the server timestamp when the next turn starts.
    activeMessageId: v.optional(v.id("assistantMessages")),
  }).index("by_user_and_lastMessage", ["userId", "lastMessageAt"]),

  // One bounded operational row per assistant user: fixed-window request quota
  // and a global one-turn lease. Keeping this separate avoids churning threads.
  assistantUserState: defineTable({
    userId: v.string(),
    windowStartMs: v.number(),
    requestCount: v.number(),
    // Rolling monthly quota, independent of the 5-minute burst window above.
    monthWindowStartMs: v.optional(v.number()),
    monthCount: v.optional(v.number()),
    activeMessageId: v.optional(v.id("assistantMessages")),
    activeThreadId: v.optional(v.id("assistantThreads")),
    leaseExpiresAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  // One row per turn. `blocks` is appended to in place while the model streams,
  // so the client's reactive subscription renders the reply as it arrives —
  // Convex actions can't stream to the browser, but a patched row does.
  assistantMessages: defineTable({
    threadId: v.id("assistantThreads"),
    // Denormalized from the thread so every read can be scoped without a join.
    userId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    blocks: v.array(assistantBlockValidator),
    // A turn that is still streaming is renderable but not yet replayable as
    // history; `error` holds why a turn stopped, for the panel to show.
    status: v.union(
      v.literal("streaming"),
      v.literal("complete"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    // Suggested next prompts, generated best-effort once a turn settles and only
    // when they'd genuinely help — usually absent. The panel renders them as
    // clickable chips under the latest reply.
    suggestions: v.optional(v.array(v.string())),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId", "createdAt"])
    // userId is denormalized here for user-scoped reads; the index also lets
    // account-deletion cleanup remove a user's messages without a thread join.
    .index("by_user", ["userId"]),

  // A write the assistant wants to make, held until the user confirms it.
  //
  // The assistant's tools never reach Google. They record one of these instead,
  // and only `assistant.confirmAction` — driven by a click — applies it. That
  // makes this table both the confirmation queue and the permanent audit trail
  // of everything the assistant ever proposed, applied, or was refused.
  assistantActions: defineTable({
    threadId: v.id("assistantThreads"),
    userId: v.string(),
    // Ties the proposal back to the tool call that produced it.
    toolCallId: v.string(),
    tool: v.string(),
    // The model's argument JSON. Re-validated against the tool's own schema at
    // apply time — never trusted just because it was stored.
    input: v.string(),
    // A one-line description of the change, written when the proposal is made.
    // The confirm card renders this, so what the user approves is stated in
    // words rather than inferred from raw arguments.
    preview: v.string(),
    // Stable across retries and used as Google's client-selected event ID.
    operationId: v.optional(v.string()),
    attemptCount: v.optional(v.number()),
    applyLeaseExpiresAt: v.optional(v.number()),
    // `applying` is the claim a confirm click takes before it calls Google, so
    // a double-click can't send the same invitation twice: the second click
    // finds the row already out of `pending` and does nothing.
    status: v.union(
      v.literal("pending"),
      v.literal("applying"),
      v.literal("applied"),
      v.literal("rejected"),
      v.literal("failed"),
    ),
    // What happened on apply: a human-readable confirmation, or the error.
    resultSummary: v.optional(v.string()),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_thread", ["threadId", "createdAt"])
    .index("by_user_and_status", ["userId", "status"]),

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
