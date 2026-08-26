/** Write side of the notifications domain: plain handlers plus the canonical
 * `mutation` / `internalMutation` registrations. The root `notifications.ts`
 * facade re-exports the registered objects so the legacy `api.notifications.*`
 * and `internal.notifications.*` paths stay live. */

import { v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "../../_generated/server";
import { authComponent } from "../../auth";
import { clearAllBatch, markAllReadBatch, ownedNotification } from "./model";

/** Mark one notification read. No-ops for a missing or foreign row. */
export async function markReadHandler(
  ctx: MutationCtx,
  notificationId: Id<"notifications">,
): Promise<void> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return;
  const notification = await ownedNotification(ctx, user._id, notificationId);
  if (notification && !notification.read) {
    await ctx.db.patch(notification._id, { read: true });
  }
}

export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: (ctx, args) => markReadHandler(ctx, args.notificationId),
});

/** Mark every unread notification read (clears the badge). */
export async function markAllReadHandler(ctx: MutationCtx): Promise<void> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return;
  const throughCreatedAt = Date.now();
  const hasMore = await markAllReadBatch(ctx, user._id, throughCreatedAt);
  if (hasMore) {
    await ctx.scheduler.runAfter(
      0,
      internal.domains.notifications.mutations.continueMarkAllRead,
      { userId: user._id, throughCreatedAt },
    );
  }
}

export const markAllRead = mutation({
  args: {},
  handler: (ctx) => markAllReadHandler(ctx),
});

/** Continue a bulk mark-read operation in bounded transactions. */
export async function continueMarkAllReadHandler(
  ctx: MutationCtx,
  args: { userId: string; throughCreatedAt: number },
): Promise<null> {
  const hasMore = await markAllReadBatch(
    ctx,
    args.userId,
    args.throughCreatedAt,
  );
  if (hasMore) {
    await ctx.scheduler.runAfter(
      0,
      internal.domains.notifications.mutations.continueMarkAllRead,
      args,
    );
  }
  return null;
}

export const continueMarkAllRead = internalMutation({
  args: { userId: v.string(), throughCreatedAt: v.number() },
  handler: (ctx, args) => continueMarkAllReadHandler(ctx, args),
});

/** Dismiss one notification — a hard delete, not a hide. */
export async function dismissHandler(
  ctx: MutationCtx,
  notificationId: Id<"notifications">,
): Promise<void> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return;
  const notification = await ownedNotification(ctx, user._id, notificationId);
  if (notification) {
    await ctx.db.delete(notification._id);
  }
}

export const dismiss = mutation({
  args: { notificationId: v.id("notifications") },
  handler: (ctx, args) => dismissHandler(ctx, args.notificationId),
});

/** Clear the whole feed — deletes every notification row for the user. */
export async function clearAllHandler(ctx: MutationCtx): Promise<void> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return;
  const throughCreatedAt = Date.now();
  const hasMore = await clearAllBatch(ctx, user._id, throughCreatedAt);
  if (hasMore) {
    await ctx.scheduler.runAfter(
      0,
      internal.domains.notifications.mutations.continueClearAll,
      { userId: user._id, throughCreatedAt },
    );
  }
}

export const clearAll = mutation({
  args: {},
  handler: (ctx) => clearAllHandler(ctx),
});

/** Continue a bulk clear operation in bounded transactions. */
export async function continueClearAllHandler(
  ctx: MutationCtx,
  args: { userId: string; throughCreatedAt: number },
): Promise<null> {
  const hasMore = await clearAllBatch(ctx, args.userId, args.throughCreatedAt);
  if (hasMore) {
    await ctx.scheduler.runAfter(
      0,
      internal.domains.notifications.mutations.continueClearAll,
      args,
    );
  }
  return null;
}

export const continueClearAll = internalMutation({
  args: { userId: v.string(), throughCreatedAt: v.number() },
  handler: (ctx, args) => continueClearAllHandler(ctx, args),
});
