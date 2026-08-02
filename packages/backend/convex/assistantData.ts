/**
 * The database half of the assistant: everything the panel subscribes to, plus
 * the internal mutations `assistant.ts` writes through.
 *
 * These live apart from the action deliberately. Convex actions have no `ctx.db`
 * and a file that runs in the Node runtime can't export queries or mutations, so
 * keeping the two halves separate leaves `assistant.ts` free to grow a
 * `"use node"` directive without dragging the reactive surface with it.
 */

import { v } from "convex/values";

import { env } from "@qali/env/server";

import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type QueryCtx,
} from "./_generated/server";
import { authComponent } from "./auth";
import { assistantBlockValidator } from "./schema";

/** How much of the opening message becomes the thread's title. */
const TITLE_MAX = 60;

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

/** Every turn in one thread, oldest first. This is the panel's main
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
    return await ctx.db
      .query("assistantMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("asc")
      .collect();
  },
});

/** Writes the assistant has proposed in this thread and is waiting on. */
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
      .order("asc")
      .collect();
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
    nowMs: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    threadId: Id<"assistantThreads">;
    assistantMessageId: Id<"assistantMessages">;
  }> => {
    let threadId = args.threadId;
    if (threadId) {
      if (!(await ownedThread(ctx, threadId, args.userId))) {
        throw new Error("Conversation not found");
      }
      await ctx.db.patch(threadId, { lastMessageAt: args.nowMs });
    } else {
      threadId = await ctx.db.insert("assistantThreads", {
        userId: args.userId,
        title: deriveTitle(args.text),
        createdAt: args.nowMs,
        lastMessageAt: args.nowMs,
      });
    }

    await ctx.db.insert("assistantMessages", {
      threadId,
      userId: args.userId,
      role: "user",
      blocks: [{ type: "text", text: args.text }],
      status: "complete",
      createdAt: args.nowMs,
    });

    const assistantMessageId = await ctx.db.insert("assistantMessages", {
      threadId,
      userId: args.userId,
      role: "assistant",
      blocks: [],
      status: "streaming",
      // One millisecond later so `by_thread` always orders the reply after the
      // message it answers, even when both land in the same tick.
      createdAt: args.nowMs + 1,
    });

    return { threadId, assistantMessageId };
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
  args: { threadId: v.id("assistantThreads"), userId: v.string() },
  handler: async (ctx, args): Promise<Doc<"assistantMessages">[]> => {
    if (!(await ownedThread(ctx, args.threadId, args.userId))) {
      return [];
    }
    const rows = await ctx.db
      .query("assistantMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("asc")
      .collect();
    return rows.filter((row) => row.status === "complete");
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
    const blocks = [...message.blocks];
    const last = blocks[blocks.length - 1];
    if (last?.type === "text") {
      blocks[blocks.length - 1] = { type: "text", text: args.text };
    } else {
      blocks.push({ type: "text", text: args.text });
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
    await ctx.db.patch(args.messageId, {
      blocks: [...message.blocks, args.block],
    });
    return null;
  },
});

/** Close a turn out. Only now does it become replayable history. */
export const finishTurn = internalMutation({
  args: {
    messageId: v.id("assistantMessages"),
    threadId: v.id("assistantThreads"),
    nowMs: v.number(),
  },
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.patch(args.messageId, { status: "complete" });
    await ctx.db.patch(args.threadId, { lastMessageAt: args.nowMs });
    return null;
  },
});

/** Mark a turn as failed, keeping whatever it managed to say. The blocks stay
 * for the user to read but `getHistory` will skip them. */
export const failTurn = internalMutation({
  args: { messageId: v.id("assistantMessages"), error: v.string() },
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.patch(args.messageId, { status: "error", error: args.error });
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
    nowMs: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"assistantActions">> => {
    return await ctx.db.insert("assistantActions", {
      threadId: args.threadId,
      userId: args.userId,
      toolCallId: args.toolCallId,
      tool: args.tool,
      input: args.input,
      preview: args.preview,
      status: "pending",
      createdAt: args.nowMs,
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
      .order("asc")
      .collect();
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
    await ctx.db.patch(args.actionId, { status: "applying" });
    return action;
  },
});

/** Record the outcome of an apply that had already claimed the row. */
export const settleClaimedAction = internalMutation({
  args: {
    actionId: v.id("assistantActions"),
    status: v.union(v.literal("applied"), v.literal("failed")),
    resultSummary: v.string(),
    nowMs: v.number(),
  },
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.patch(args.actionId, {
      status: args.status,
      resultSummary: args.resultSummary,
      decidedAt: args.nowMs,
    });
    return null;
  },
});

/** Discard a proposal without applying it. Same pending-only guard as the
 * claim, so Discard can't undo a confirm that is already in flight. */
export const rejectAction = internalMutation({
  args: {
    actionId: v.id("assistantActions"),
    userId: v.string(),
    nowMs: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const action = await ctx.db.get(args.actionId);
    if (!action || action.userId !== args.userId || action.status !== "pending") {
      return false;
    }
    await ctx.db.patch(args.actionId, {
      status: "rejected",
      decidedAt: args.nowMs,
    });
    return true;
  },
});
