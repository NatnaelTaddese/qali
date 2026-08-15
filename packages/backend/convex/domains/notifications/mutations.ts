/** Write handlers for the notifications domain. Plain functions; the root
 * `notifications.ts` wraps each in a Convex `mutation` / `internalMutation`, and
 * the recurring bulk continuations reschedule through those stable paths. */

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
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

/** Mark every unread notification read (clears the badge). */
export async function markAllReadHandler(ctx: MutationCtx): Promise<void> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return;
  const throughCreatedAt = Date.now();
  const hasMore = await markAllReadBatch(ctx, user._id, throughCreatedAt);
  if (hasMore) {
    await ctx.scheduler.runAfter(
      0,
      internal.notifications.continueMarkAllRead,
      { userId: user._id, throughCreatedAt },
    );
  }
}

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
      internal.notifications.continueMarkAllRead,
      args,
    );
  }
  return null;
}

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

/** Clear the whole feed — deletes every notification row for the user. */
export async function clearAllHandler(ctx: MutationCtx): Promise<void> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return;
  const throughCreatedAt = Date.now();
  const hasMore = await clearAllBatch(ctx, user._id, throughCreatedAt);
  if (hasMore) {
    await ctx.scheduler.runAfter(0, internal.notifications.continueClearAll, {
      userId: user._id,
      throughCreatedAt,
    });
  }
}

/** Continue a bulk clear operation in bounded transactions. */
export async function continueClearAllHandler(
  ctx: MutationCtx,
  args: { userId: string; throughCreatedAt: number },
): Promise<null> {
  const hasMore = await clearAllBatch(ctx, args.userId, args.throughCreatedAt);
  if (hasMore) {
    await ctx.scheduler.runAfter(
      0,
      internal.notifications.continueClearAll,
      args,
    );
  }
  return null;
}
