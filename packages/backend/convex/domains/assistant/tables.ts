import { defineTable } from "convex/server";
import { v } from "convex/values";

import { assistantBlockValidator } from "./validators";

/** Table definitions owned by the assistant domain, composed into schema.ts. */
export const assistantTables = {
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
  // so the client's reactive subscription renders the reply as it arrives.
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
    // when they'd genuinely help — usually absent.
    suggestions: v.optional(v.array(v.string())),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId", "createdAt"])
    // userId is denormalized here for user-scoped reads; the index also lets
    // account-deletion cleanup remove a user's messages without a thread join.
    .index("by_user", ["userId"]),

  // A write the assistant wants to make, held until the user confirms it. The
  // assistant's tools never reach Google — they record one of these instead, and
  // only `assistant.confirmAction` (a click) applies it. Both the confirmation
  // queue and the permanent audit trail of everything ever proposed.
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
    preview: v.string(),
    // Stable across retries and used as Google's client-selected event ID.
    operationId: v.optional(v.string()),
    attemptCount: v.optional(v.number()),
    attemptId: v.optional(v.string()),
    applyLeaseExpiresAt: v.optional(v.number()),
    // `applying` is the claim a confirm click takes before it calls Google, so
    // a double-click can't send the same invitation twice.
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
};
