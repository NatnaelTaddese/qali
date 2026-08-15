/**
 * Assistant conversation retention.
 *
 * Two forces keep the assistant tables bounded:
 *  - `deleteThread` (user-driven): pressing "New chat" discards the prior
 *    conversation, so at most a handful of threads ever accumulate.
 *  - `pruneAgedThreads` (cron): a daily sweep that removes any thread untouched
 *    for 30 days, catching threads left behind rather than replaced.
 *
 * Both go through `deleteThreadCascade`, so a thread never outlives — or is
 * outlived by — its messages and proposed actions.
 */

import { v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "../../_generated/server";
import { authComponent } from "../../auth";

const THREAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const THREAD_PAGE = 100;

/** Delete a thread with everything hanging off it: its messages, its proposed
 * actions, and any lingering pointer to it in the owner's operational state.
 * Turn counts are capped per user, so a single thread's rows are small enough
 * to collect in one pass. */
async function deleteThreadCascade(
  ctx: MutationCtx,
  threadId: Id<"assistantThreads">,
): Promise<void> {
  const messages = await ctx.db
    .query("assistantMessages")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  for (const message of messages) {
    await ctx.db.delete(message._id);
  }

  const actions = await ctx.db
    .query("assistantActions")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  for (const action of actions) {
    await ctx.db.delete(action._id);
  }

  const thread = await ctx.db.get(threadId);
  if (thread) {
    const state = await ctx.db
      .query("assistantUserState")
      .withIndex("by_user", (q) => q.eq("userId", thread.userId))
      .unique();
    if (state?.activeThreadId === threadId) {
      await ctx.db.patch(state._id, {
        activeThreadId: undefined,
        activeMessageId: undefined,
        leaseExpiresAt: undefined,
      });
    }
  }

  await ctx.db.delete(threadId);
}

/**
 * Discard one conversation the caller owns. Called when the user starts a new
 * chat: the conversation they were just in is deleted rather than kept.
 *
 * Safe to call mid-stream — the in-flight turn's writes all no-op once their
 * message row is gone — so it needs no busy guard. Silently does nothing when
 * the thread is missing or owned by someone else; there is nothing to reveal.
 */
export const deleteThread = mutation({
  args: { threadId: v.id("assistantThreads") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return null;
    }
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.userId !== user._id) {
      return null;
    }
    await deleteThreadCascade(ctx, args.threadId);
    return null;
  },
});

/**
 * Daily sweep: delete threads whose last activity is older than the retention
 * horizon. Paginates the (small) table and skips any thread with a turn still
 * streaming, so an active conversation is never pulled out from under a run.
 */
export const pruneAgedThreads = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const cutoff = Date.now() - THREAD_RETENTION_MS;
    const page = await ctx.db
      .query("assistantThreads")
      .paginate({ cursor: args.cursor ?? null, numItems: THREAD_PAGE });
    for (const thread of page.page) {
      if (thread.lastMessageAt < cutoff && !thread.activeMessageId) {
        await deleteThreadCascade(ctx, thread._id);
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.assistantMaintenance.pruneAgedThreads,
        { cursor: page.continueCursor },
      );
    }
    return null;
  },
});
