/**
 * The database half of the assistant: everything the panel subscribes to, plus
 * the internal mutations `assistant.ts` writes through.
 *
 * These live apart from the action deliberately. Convex actions have no `ctx.db`
 * and a file that runs in the Node runtime can't export queries or mutations, so
 * keeping the two halves separate leaves `assistant.ts` free to grow a
 * `"use node"` directive without dragging the reactive surface with it.
 */

import { ConvexError, v } from "convex/values";

import { env } from "@qali/env/server";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import { authComponent } from "../../auth";
import { consumeRateLimit } from "../../infrastructure/rateLimit";
import { assistantBlockValidator } from "./validators";

/** How much of the opening message becomes the thread's title. */
const TITLE_MAX = 60;
const MESSAGE_MAX = 4_000;
const MESSAGE_LIST_LIMIT = 100;
const HISTORY_MESSAGE_LIMIT = 24;
const HISTORY_CHAR_LIMIT = 120_000;
const ACTION_LIST_LIMIT = 100;
const MAX_BLOCKS_PER_MESSAGE = 64;
const MAX_BLOCK_TEXT = 8_000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_TURNS_PER_WINDOW = 20;
const MONTH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // rolling 30 days
const MAX_TURNS_PER_MONTH = 10;
// A deployment-wide ceiling on model calls per day. The per-user quotas bound
// one account; this bounds the bill when many accounts are minted at once.
const GLOBAL_TURN_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TURNS_GLOBAL_PER_DAY = 2_000;
const PREVIEW_MAX = 2_000;
const TURN_LEASE_MS = 10 * 60 * 1000;
const MAX_ACTION_ATTEMPTS = 5;
const ACTION_LEASE_MS = 12 * 60 * 1000;
const ASSISTANT_EVENT_LIMIT = 250;
const ASSISTANT_BOOKING_LIMIT = 250;
const ASSISTANT_CALENDAR_LIMIT = 100;
const MAX_EVENT_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

export function monthlyUsageAt(
  state: { monthWindowStartMs?: number; monthCount?: number } | null,
  nowMs: number,
): number {
  return state?.monthWindowStartMs !== undefined &&
    nowMs - state.monthWindowStartMs < MONTH_WINDOW_MS
    ? (state.monthCount ?? 0)
    : 0;
}

function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_MAX) {
    return flat || "New conversation";
  }
  return `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/** A thread the given user owns, or null. Every read below goes through this —
 * `threadId` arrives from the client and proves nothing on its own. */
async function ownedThread(
  ctx: QueryCtx,
  threadId: Id<"assistantThreads">,
  userId: string,
): Promise<Doc<"assistantThreads"> | null> {
  const thread = await ctx.db.get(threadId);
  return thread && thread.userId === userId ? thread : null;
}

/**
 * Whether this deployment has an assistant at all.
 *
 * The whole feature is gated on one optional environment variable, and the dock
 * asks this before rendering anything. It returns a boolean and never the key
 * itself — the client has no reason to know more than on/off.
 */
export const isAvailable = query({
  args: {},
  handler: async (): Promise<boolean> => {
    return env.DEEPSEEK_API_KEY !== undefined;
  },
});

/**
 * The signed-in user's rolling-30-day message allowance. The composer
 * subscribes to this to show remaining messages and block sending when spent.
 * Mirrors the window logic in `startTurn` so the two never disagree.
 */
export const monthlyQuota = query({
  args: { nowMs: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ used: number; limit: number; remaining: number }> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return { used: 0, limit: MAX_TURNS_PER_MONTH, remaining: MAX_TURNS_PER_MONTH };
    }
    const state = await ctx.db
      .query("assistantUserState")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    // Older clients sent `{}`. Keep that call valid without reading a query
    // wall clock; mutations remain authoritative and a current client supplies
    // a periodically refreshed time for window rollover display.
    const now = args.nowMs ?? state?.monthWindowStartMs ?? 0;
    const used = monthlyUsageAt(state, now);
    return {
      used,
      limit: MAX_TURNS_PER_MONTH,
      remaining: Math.max(0, MAX_TURNS_PER_MONTH - used),
    };
  },
});

/** The user's conversations, most recently active first. */
export const listThreads = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    return await ctx.db
      .query("assistantThreads")
      .withIndex("by_user_and_lastMessage", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(30);
  },
});

/** The latest turns in one thread, oldest first. This is the panel's main
 * subscription: the action patches the in-flight assistant row as the model
 * streams, and each patch re-runs this query on the client. */
export const listMessages = query({
  args: { threadId: v.id("assistantThreads") },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    if (!(await ownedThread(ctx, args.threadId, user._id))) {
      return [];
    }
    const rows = await ctx.db
      .query("assistantMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .take(MESSAGE_LIST_LIMIT);
    return rows.reverse();
  },
});

/** All proposed writes in this thread, in any state (pending, applying,
 * applied, rejected, failed). The panel uses these to resolve `proposal`
 * blocks across the whole thread, not just the ones awaiting the user. */
export const listPendingActions = query({
  args: { threadId: v.id("assistantThreads") },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    if (!(await ownedThread(ctx, args.threadId, user._id))) {
      return [];
    }
    return await ctx.db
      .query("assistantActions")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .take(ACTION_LIST_LIMIT)
      .then((rows) => rows.reverse());
  },
});

/**
 * Open a turn: create the thread if this is the first message, store what the
 * user said, and park an empty assistant row for the stream to fill.
 *
 * Both rows are written in one transaction so the panel never renders a user
 * message with no reply pending underneath it.
 */
export const startTurn = internalMutation({
  args: {
    userId: v.string(),
    threadId: v.optional(v.id("assistantThreads")),
    text: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    threadId: Id<"assistantThreads">;
    userMessageId: Id<"assistantMessages">;
    assistantMessageId: Id<"assistantMessages">;
    startedAt: number;
  }> => {
    const now = Date.now();
    if (args.text.length > MESSAGE_MAX) {
      throw new ConvexError({ code: "ASSISTANT_MESSAGE_TOO_LONG" });
    }

    const state = await ctx.db
      .query("assistantUserState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (
      state?.activeMessageId &&
      state.leaseExpiresAt !== undefined &&
      state.leaseExpiresAt > now
    ) {
      throw new ConvexError({ code: "ASSISTANT_BUSY" });
    }
    if (state?.activeMessageId) {
      const staleMessage = await ctx.db.get(state.activeMessageId);
      if (staleMessage?.status === "streaming") {
        await ctx.db.patch(staleMessage._id, {
          status: "error",
          error: "The previous assistant turn timed out.",
        });
      }
      if (state.activeThreadId) {
        const staleThread = await ctx.db.get(state.activeThreadId);
        if (staleThread?.activeMessageId === state.activeMessageId) {
          await ctx.db.patch(staleThread._id, { activeMessageId: undefined });
        }
      }
    }

    const inCurrentWindow =
      state !== null && now - state.windowStartMs < RATE_WINDOW_MS;
    const requestCount = inCurrentWindow ? state.requestCount : 0;
    if (requestCount >= MAX_TURNS_PER_WINDOW) {
      throw new ConvexError({ code: "ASSISTANT_RATE_LIMIT" });
    }

    const inMonthWindow =
      state?.monthWindowStartMs !== undefined &&
      now - state.monthWindowStartMs < MONTH_WINDOW_MS;
    const monthCount = inMonthWindow ? (state.monthCount ?? 0) : 0;
    if (monthCount >= MAX_TURNS_PER_MONTH) {
      throw new ConvexError({ code: "ASSISTANT_MONTHLY_LIMIT" });
    }
    if (
      !(await consumeRateLimit(
        ctx,
        "assistant:global",
        MAX_TURNS_GLOBAL_PER_DAY,
        GLOBAL_TURN_WINDOW_MS,
      ))
    ) {
      throw new ConvexError({ code: "ASSISTANT_RATE_LIMIT" });
    }

    let threadId = args.threadId;
    if (threadId) {
      const thread = await ownedThread(ctx, threadId, args.userId);
      if (!thread) {
        throw new Error("Conversation not found");
      }
      if (thread.activeMessageId) {
        const active = await ctx.db.get(thread.activeMessageId);
        if (active?.status === "streaming" && active.createdAt > now - TURN_LEASE_MS) {
          throw new ConvexError({ code: "ASSISTANT_THREAD_BUSY" });
        }
        if (active?.status === "streaming") {
          await ctx.db.patch(active._id, {
            status: "error",
            error: "The previous assistant turn timed out.",
          });
        }
      }
      await ctx.db.patch(threadId, {
        lastMessageAt: now,
        activeMessageId: undefined,
      });
    } else {
      threadId = await ctx.db.insert("assistantThreads", {
        userId: args.userId,
        title: deriveTitle(args.text),
        createdAt: now,
        lastMessageAt: now,
      });
    }

    const userMessageId = await ctx.db.insert("assistantMessages", {
      threadId,
      userId: args.userId,
      role: "user",
      blocks: [{ type: "text", text: args.text }],
      status: "complete",
      createdAt: now,
    });

    const assistantMessageId = await ctx.db.insert("assistantMessages", {
      threadId,
      userId: args.userId,
      role: "assistant",
      blocks: [],
      status: "streaming",
      createdAt: now,
    });

    await ctx.db.patch(threadId, { activeMessageId: assistantMessageId });
    const stateValue = {
      windowStartMs: inCurrentWindow && state ? state.windowStartMs : now,
      requestCount: requestCount + 1,
      monthWindowStartMs:
        inMonthWindow && state?.monthWindowStartMs !== undefined
          ? state.monthWindowStartMs
          : now,
      monthCount: monthCount + 1,
      activeMessageId: assistantMessageId,
      activeThreadId: threadId,
      leaseExpiresAt: now + TURN_LEASE_MS,
    };
    if (state) {
      await ctx.db.patch(state._id, stateValue);
    } else {
      await ctx.db.insert("assistantUserState", {
        userId: args.userId,
        ...stateValue,
      });
    }

    return { threadId, userMessageId, assistantMessageId, startedAt: now };
  },
});

/**
 * Replayable history for the next request: every finished turn, oldest first.
 *
 * Filtering on `complete` is what excludes the placeholder this very turn just
 * created, and it also drops half-written turns from a run that errored — a
 * turn that stopped mid-tool-call would otherwise be replayed as an assistant
 * message whose tool calls have no results, which the API rejects.
 */
export const getHistory = internalQuery({
  args: {
    threadId: v.id("assistantThreads"),
    userId: v.string(),
    userMessageId: v.id("assistantMessages"),
  },
  handler: async (ctx, args): Promise<Doc<"assistantMessages">[]> => {
    if (!(await ownedThread(ctx, args.threadId, args.userId))) {
      return [];
    }
    const current = await ctx.db.get(args.userMessageId);
    if (
      !current ||
      current.threadId !== args.threadId ||
      current.userId !== args.userId ||
      current.role !== "user"
    ) {
      throw new Error("Assistant request not found");
    }
    const rows = await ctx.db
      .query("assistantMessages")
      .withIndex("by_thread", (q) =>
        q.eq("threadId", args.threadId).lte("createdAt", current.createdAt),
      )
      .order("desc")
      .take(HISTORY_MESSAGE_LIMIT + 2);
    const completeDesc: Doc<"assistantMessages">[] = [];
    let historyChars = 0;
    for (const row of rows) {
      if (row.status !== "complete") continue;
      const rowChars = row.blocks.reduce((total, block) => {
        if (block.type === "text") return total + block.text.length;
        if (block.type === "tool_call") return total + block.arguments.length;
        if (block.type === "tool_result") return total + block.content.length;
        return total;
      }, 0);
      if (completeDesc.length > 0 && historyChars + rowChars > HISTORY_CHAR_LIMIT) {
        break;
      }
      completeDesc.push(row);
      historyChars += rowChars;
      if (completeDesc.length >= HISTORY_MESSAGE_LIMIT) break;
    }
    const complete = completeDesc.reverse();
    while (complete[0]?.role === "assistant") complete.shift();
    if (!complete.some((row) => row._id === args.userMessageId)) {
      throw new Error("Assistant request fell outside bounded history");
    }
    return complete;
  },
});

/** Bounded calendar read for assistant tools. Public calendar range queries are
 * optimized for the visible grid and may collect a dense range in full. */
export const listEventsForAssistant = internalQuery({
  args: {
    userId: v.string(),
    startMs: v.number(),
    endMs: v.number(),
  },
  handler: async (ctx, args): Promise<Doc<"events">[]> => {
    if (
      !Number.isFinite(args.startMs) ||
      !Number.isFinite(args.endMs) ||
      args.endMs <= args.startMs ||
      args.endMs - args.startMs > MAX_EVENT_RANGE_MS
    ) {
      throw new Error("Use a valid calendar range no longer than 400 days");
    }
    const calendars = await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(ASSISTANT_CALENDAR_LIMIT + 1);
    if (calendars.length > ASSISTANT_CALENDAR_LIMIT) {
      throw new Error("Too many calendars to search safely");
    }

    const rows: Doc<"events">[] = [];
    for (const calendar of calendars) {
      const connectionId = calendar.connectionId;
      if (!calendar.selected || connectionId === undefined) continue;
      const remaining = ASSISTANT_EVENT_LIMIT - rows.length;
      const calendarRows = await ctx.db
        .query("events")
        .withIndex("by_connection_and_localCalendarId_and_endMs", (q) =>
          q
            .eq("connectionId", connectionId)
            .eq("localCalendarId", calendar._id)
            .gt("endMs", args.startMs),
        )
        .filter((q) =>
          q.and(
            q.lt(q.field("startMs"), args.endMs),
            q.neq(q.field("status"), "cancelled"),
          ),
        )
        .take(remaining + 1);
      if (calendarRows.length > remaining) {
        throw new Error("That calendar range is too dense; use a smaller range");
      }
      rows.push(...calendarRows);
    }
    return rows.sort((a, b) => a.startMs - b.startMs);
  },
});

/** Pending and accepted bookings both reserve time. Accepted rows remain here
 * even if their optimistic event mirror failed and calendar sync has not caught
 * up yet; interval merging removes the duplicate once the event appears. */
export const listBookingBlocksForAssistant = internalQuery({
  args: {
    userId: v.string(),
    startMs: v.number(),
    endMs: v.number(),
  },
  handler: async (ctx, args): Promise<Doc<"bookings">[]> => {
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_host_and_end", (q) =>
        q.eq("hostUserId", args.userId).gt("endMs", args.startMs),
      )
      .order("asc")
      .filter((q) =>
        q.and(
          q.lt(q.field("startMs"), args.endMs),
          q.or(
            q.eq(q.field("status"), "pending"),
            q.eq(q.field("status"), "accepted"),
          ),
        ),
      )
      .take(ASSISTANT_BOOKING_LIMIT + 1);
    if (rows.length > ASSISTANT_BOOKING_LIMIT) {
      throw new Error("That booking range is too dense; use a smaller range");
    }
    return rows;
  },
});

export const getRecurringSeriesVersion = internalQuery({
  args: {
    userId: v.string(),
    eventId: v.id("events"),
  },
  handler: async (ctx, args): Promise<number | null> => {
    const event = await ctx.db.get(args.eventId);
    if (!event || event.userId !== args.userId) {
      return null;
    }
    const { connectionId, localCalendarId, providerSeriesId } = event;
    if (
      connectionId === undefined ||
      localCalendarId === undefined ||
      providerSeriesId === undefined
    ) {
      return null;
    }
    // The series master's provider event id is the instance's series id.
    const series = await ctx.db
      .query("recurringSeries")
      .withIndex("by_connection_and_localCalendarId_and_providerEventId", (q) =>
        q
          .eq("connectionId", connectionId)
          .eq("localCalendarId", localCalendarId)
          .eq("providerEventId", providerSeriesId),
      )
      .unique();
    return series?.providerUpdatedMs ?? null;
  },
});

/**
 * Write the assistant's prose so far.
 *
 * Called on a timer while text streams, always with the *whole* run of text
 * rather than the latest delta, so it replaces a trailing text block instead of
 * appending one. That makes it idempotent: a flush that lands twice, or one
 * that raced a slower earlier flush, still leaves exactly one text block.
 */
export const flushText = internalMutation({
  args: { messageId: v.id("assistantMessages"), text: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const message = await ctx.db.get(args.messageId);
    if (!message) {
      return null;
    }
    if (message.status !== "streaming") return null;
    const blocks = [...message.blocks];
    const last = blocks[blocks.length - 1];
    if (last?.type === "text") {
      blocks[blocks.length - 1] = {
        type: "text",
        text: args.text.slice(0, MAX_BLOCK_TEXT),
      };
    } else {
      if (blocks.length >= MAX_BLOCKS_PER_MESSAGE) return null;
      blocks.push({ type: "text", text: args.text.slice(0, MAX_BLOCK_TEXT) });
    }
    await ctx.db.patch(args.messageId, { blocks });
    return null;
  },
});

/** Append one non-text block (a tool call, its result, or a proposal marker). */
export const appendBlock = internalMutation({
  args: {
    messageId: v.id("assistantMessages"),
    block: assistantBlockValidator,
  },
  handler: async (ctx, args): Promise<null> => {
    const message = await ctx.db.get(args.messageId);
    if (!message) {
      return null;
    }
    if (message.status !== "streaming") {
      return null;
    }
    if (message.blocks.length >= MAX_BLOCKS_PER_MESSAGE) {
      throw new ConvexError({ code: "ASSISTANT_RESPONSE_TOO_LONG" });
    }
    if (
      (args.block.type === "tool_call" &&
        args.block.arguments.length > MAX_BLOCK_TEXT) ||
      (args.block.type === "tool_result" &&
        args.block.content.length > MAX_BLOCK_TEXT)
    ) {
      throw new ConvexError({ code: "ASSISTANT_RESPONSE_TOO_LONG" });
    }
    await ctx.db.patch(args.messageId, {
      blocks: [...message.blocks, args.block],
    });
    return null;
  },
});

/** Attach best-effort follow-up suggestions to a settled turn. Independent of
 * the turn's success path: a failure to generate them must never touch status,
 * so this only writes the field and tolerates the message being gone. */
export const setSuggestions = internalMutation({
  args: {
    messageId: v.id("assistantMessages"),
    suggestions: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.status === "error") {
      return null;
    }
    await ctx.db.patch(args.messageId, { suggestions: args.suggestions });
    return null;
  },
});

/** Close a turn out. Only now does it become replayable history. */
export const finishTurn = internalMutation({
  args: {
    messageId: v.id("assistantMessages"),
    threadId: v.id("assistantThreads"),
  },
  handler: async (ctx, args): Promise<null> => {
    const message = await ctx.db.get(args.messageId);
    const thread = await ctx.db.get(args.threadId);
    if (
      message?.status !== "streaming" ||
      thread?.activeMessageId !== args.messageId
    ) {
      return null;
    }
    await ctx.db.patch(args.messageId, { status: "complete" });
    await releaseTurn(ctx, args.messageId, args.threadId, Date.now());
    return null;
  },
});

/** Mark a turn as failed, keeping whatever it managed to say. The blocks stay
 * for the user to read but `getHistory` will skip them. */
export const failTurn = internalMutation({
  args: {
    messageId: v.id("assistantMessages"),
    threadId: v.id("assistantThreads"),
    error: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    const message = await ctx.db.get(args.messageId);
    const thread = await ctx.db.get(args.threadId);
    if (
      message?.status !== "streaming" ||
      thread?.activeMessageId !== args.messageId
    ) {
      return null;
    }
    await ctx.db.patch(args.messageId, {
      status: "error",
      error: args.error.slice(0, 2_000),
    });
    await releaseTurn(ctx, args.messageId, args.threadId, Date.now());
    return null;
  },
});

/** Park a write the assistant wants to make. Returns the id the transcript's
 * `proposal` block points at, which is what the confirm card renders from. */
export const recordProposal = internalMutation({
  args: {
    threadId: v.id("assistantThreads"),
    userId: v.string(),
    toolCallId: v.string(),
    tool: v.string(),
    input: v.string(),
    preview: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"assistantActions">> => {
    if (args.input.length > MAX_BLOCK_TEXT) {
      throw new ConvexError({ code: "ASSISTANT_PROPOSAL_TOO_LARGE" });
    }
    return await ctx.db.insert("assistantActions", {
      threadId: args.threadId,
      userId: args.userId,
      toolCallId: args.toolCallId,
      tool: args.tool,
      input: args.input,
      // A cut preview must read as cut: the card is what the user confirms,
      // and a silent slice would let the tail of a change go unread.
      preview:
        args.preview.length <= PREVIEW_MAX
          ? args.preview
          : `${args.preview.slice(0, PREVIEW_MAX - 1)}… (truncated — open Details for the full change)`,
      operationId: crypto.randomUUID(),
      attemptCount: 0,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

/**
 * Every proposal in a thread, decided or not.
 *
 * The agent loop reads these when rebuilding history so a stored tool result
 * can be replaced with what actually became of it. Without that the model would
 * keep reading its own "awaiting confirmation" reply from three turns ago and
 * ask the user to confirm something they already confirmed.
 */
export const getThreadActions = internalQuery({
  args: { threadId: v.id("assistantThreads"), userId: v.string() },
  handler: async (ctx, args): Promise<Doc<"assistantActions">[]> => {
    if (!(await ownedThread(ctx, args.threadId, args.userId))) {
      return [];
    }
    return await ctx.db
      .query("assistantActions")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .take(ACTION_LIST_LIMIT)
      .then((rows) => rows.reverse());
  },
});

/**
 * Take ownership of a pending proposal before applying it.
 *
 * The pending check and the status write happen in one transaction, which is
 * the whole point: two confirm clicks race here rather than at Google, and only
 * the one that flips `pending` → `applying` gets to send the invitation. The
 * loser returns false and does nothing.
 */
export const claimAction = internalMutation({
  args: {
    actionId: v.id("assistantActions"),
    userId: v.string(),
  },
  handler: async (ctx, args): Promise<Doc<"assistantActions"> | null> => {
    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== args.userId) {
      return null;
    }
    if (action.status !== "pending") {
      return null;
    }
    const attemptCount = (action.attemptCount ?? 0) + 1;
    if (attemptCount > MAX_ACTION_ATTEMPTS) {
      await ctx.db.patch(args.actionId, {
        status: "failed",
        resultSummary: "This change could not be reconciled after several attempts.",
        decidedAt: Date.now(),
      });
      return null;
    }
    const operationId = action.operationId ?? crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const applyLeaseExpiresAt = Date.now() + ACTION_LEASE_MS;
    await ctx.db.patch(args.actionId, {
      status: "applying",
      operationId,
      attemptCount,
      attemptId,
      applyLeaseExpiresAt,
    });
    await ctx.scheduler.runAt(
      applyLeaseExpiresAt,
      internal.domains.assistant.data.releaseStaleAction,
      { actionId: args.actionId, attemptId, applyLeaseExpiresAt },
    );
    return {
      ...action,
      operationId,
      attemptCount,
      attemptId,
      applyLeaseExpiresAt,
      status: "applying" as const,
    };
  },
});

/** Record the outcome of an apply that had already claimed the row. */
export const settleClaimedAction = internalMutation({
  args: {
    actionId: v.id("assistantActions"),
    attemptId: v.optional(v.string()),
    status: v.union(v.literal("applied"), v.literal("failed")),
    resultSummary: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    const action = await ctx.db.get(args.actionId);
    if (
      action?.status !== "applying" ||
      (action.attemptId === undefined
        ? args.attemptId !== undefined
        : action.attemptId !== args.attemptId)
    ) return null;
    await ctx.db.patch(args.actionId, {
      status: args.status,
      resultSummary: args.resultSummary,
      decidedAt: Date.now(),
      applyLeaseExpiresAt: undefined,
      attemptId: undefined,
    });
    return null;
  },
});

/** Put a claimed action back behind its confirm button. Stable operation IDs
 * make the retry reconcile a possible lost Google response instead of creating
 * a second event. */
export const retryClaimedAction = internalMutation({
  args: {
    actionId: v.id("assistantActions"),
    attemptId: v.optional(v.string()),
    resultSummary: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    const action = await ctx.db.get(args.actionId);
    if (
      action?.status === "applying" &&
      (action.attemptId === undefined
        ? args.attemptId === undefined
        : action.attemptId === args.attemptId)
    ) {
      await ctx.db.patch(args.actionId, {
        status: "pending",
        resultSummary: args.resultSummary.slice(0, 2_000),
        applyLeaseExpiresAt: undefined,
        attemptId: undefined,
      });
    }
    return null;
  },
});

/** Recover a confirmation whose action process disappeared after claiming it.
 * The operation ID remains stable, so the next click reconciles with Google. */
export const releaseStaleAction = internalMutation({
  args: {
    actionId: v.id("assistantActions"),
    attemptId: v.optional(v.string()),
    applyLeaseExpiresAt: v.number(),
  },
  handler: async (ctx, args): Promise<null> => {
    const action = await ctx.db.get(args.actionId);
    if (
      action?.status === "applying" &&
      (action.attemptId === undefined
        ? args.attemptId === undefined
        : action.attemptId === args.attemptId) &&
      action.applyLeaseExpiresAt === args.applyLeaseExpiresAt &&
      args.applyLeaseExpiresAt <= Date.now()
    ) {
      await ctx.db.patch(args.actionId, {
        status: "pending",
        applyLeaseExpiresAt: undefined,
        attemptId: undefined,
        resultSummary:
          "The previous confirmation was interrupted. Retry to reconcile it safely.",
      });
    }
    return null;
  },
});

/** Discard a proposal without applying it. Same pending-only guard as the
 * claim, so Discard can't undo a confirm that is already in flight. */
export const rejectAction = internalMutation({
  args: {
    actionId: v.id("assistantActions"),
    userId: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== args.userId || action.status !== "pending") {
      return false;
    }
    await ctx.db.patch(args.actionId, {
      status: "rejected",
      decidedAt: Date.now(),
    });
    return true;
  },
});

async function releaseTurn(
  ctx: MutationCtx,
  messageId: Id<"assistantMessages">,
  threadId: Id<"assistantThreads">,
  now: number,
): Promise<void> {
  const thread = await ctx.db.get(threadId);
  const message = await ctx.db.get(messageId);
  if (thread?.activeMessageId === messageId) {
    await ctx.db.patch(threadId, {
      activeMessageId: undefined,
      lastMessageAt: now,
    });
  }
  const state = await ctx.db
    .query("assistantUserState")
    .withIndex("by_user", (q) => q.eq("userId", message?.userId ?? ""))
    .unique();
  if (state?.activeMessageId === messageId) {
    await ctx.db.patch(state._id, {
      activeMessageId: undefined,
      activeThreadId: undefined,
      leaseExpiresAt: undefined,
    });
  }
}
