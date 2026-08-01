/**
 * In-app notifications for a host: the events worth surfacing (currently a new
 * booking request) write a row here, and the header notification bell reads it.
 *
 * Two deliberate shapes: `read` drives the unread badge (marking read keeps the
 * row), while dismissal is a hard `delete` — clearing a notification removes it
 * from the table so the feed and the DB never drift apart.
 */

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { authComponent } from "./auth";
import { selectVisibleNotifications } from "./lib/notifications";

/** How many notifications the bell shows at once. */
const MAX_NOTIFICATIONS = 30;
/** Enough to render "9+" without counting the whole table. */
const UNREAD_CAP = 10;
/** Keep bulk actions comfortably inside one Convex transaction. */
const BULK_BATCH_SIZE = 100;

export type NotificationWithBooking = Doc<"notifications"> & {
  booking: Doc<"bookings"> | null;
};

/** Delete every notification spawned by a booking. Called when the booking is
 * accepted, declined, or expires, so a resolved request stops showing in the
 * bell. Safe to call from any mutation that owns the booking's lifecycle. */
export async function clearBookingNotifications(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
): Promise<void> {
  const rows = await ctx.db
    .query("notifications")
    .withIndex("by_booking", (q) => q.eq("bookingId", bookingId))
    .collect();
  await Promise.all(rows.map((row) => ctx.db.delete(row._id)));
}

/** Load one notification and confirm it belongs to the caller. Returns null for
 * a missing row or another user's row, so callers can no-op silently. */
async function ownedNotification(
  ctx: MutationCtx,
  userId: string,
  notificationId: Id<"notifications">,
): Promise<Doc<"notifications"> | null> {
  const notification = await ctx.db.get(notificationId);
  if (!notification || notification.userId !== userId) {
    return null;
  }
  return notification;
}

/** Unread notifications first, followed by the most recent read history.
 * Prioritizing unread rows keeps every unread item reachable through the fixed
 * feed window as earlier rows are read. Booking notifications carry their
 * booking doc so a click can open the dock panel. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<NotificationWithBooking[]> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_and_read", (q) =>
        q.eq("userId", user._id).eq("read", false),
      )
      .order("desc")
      .take(MAX_NOTIFICATIONS);
    const recent =
      unread.length < MAX_NOTIFICATIONS
        ? await ctx.db
            .query("notifications")
            .withIndex("by_user_and_created", (q) => q.eq("userId", user._id))
            .order("desc")
            .take(MAX_NOTIFICATIONS)
        : [];
    const rows = selectVisibleNotifications(
      unread,
      recent,
      MAX_NOTIFICATIONS,
    );
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        booking: row.bookingId ? await ctx.db.get(row.bookingId) : null,
      })),
    );
  },
});

/** Unread count for the badge, capped so it never scans the whole table. */
export const unreadCount = query({
  args: {},
  handler: async (ctx): Promise<number> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return 0;
    }
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_and_read", (q) =>
        q.eq("userId", user._id).eq("read", false),
      )
      .take(UNREAD_CAP);
    return unread.length;
  },
});

/** Mark one notification read. No-ops for a missing or foreign row. */
export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, args): Promise<void> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return;
    }
    const notification = await ownedNotification(
      ctx,
      user._id,
      args.notificationId,
    );
    if (notification && !notification.read) {
      await ctx.db.patch(notification._id, { read: true });
    }
  },
});

async function markAllReadBatch(
  ctx: MutationCtx,
  userId: string,
  throughCreatedAt: number,
): Promise<boolean> {
  const unread = await ctx.db
    .query("notifications")
    .withIndex("by_user_and_read_and_created", (q) =>
      q
        .eq("userId", userId)
        .eq("read", false)
        .lte("createdAt", throughCreatedAt),
    )
    .take(BULK_BATCH_SIZE);
  await Promise.all(unread.map((row) => ctx.db.patch(row._id, { read: true })));
  return unread.length === BULK_BATCH_SIZE;
}

async function clearAllBatch(
  ctx: MutationCtx,
  userId: string,
  throughCreatedAt: number,
): Promise<boolean> {
  const rows = await ctx.db
    .query("notifications")
    .withIndex("by_user_and_created", (q) =>
      q.eq("userId", userId).lte("createdAt", throughCreatedAt),
    )
    .take(BULK_BATCH_SIZE);
  await Promise.all(rows.map((row) => ctx.db.delete(row._id)));
  return rows.length === BULK_BATCH_SIZE;
}

/** Mark every unread notification read (clears the badge). */
export const markAllRead = mutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return;
    }
    const throughCreatedAt = Date.now();
    const hasMore = await markAllReadBatch(ctx, user._id, throughCreatedAt);
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.notifications.continueMarkAllRead,
        { userId: user._id, throughCreatedAt },
      );
    }
  },
});

/** Continue a bulk mark-read operation in bounded transactions. */
export const continueMarkAllRead = internalMutation({
  args: { userId: v.string(), throughCreatedAt: v.number() },
  handler: async (ctx, args): Promise<null> => {
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
  },
});

/** Dismiss one notification — a hard delete, not a hide. */
export const dismiss = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, args): Promise<void> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return;
    }
    const notification = await ownedNotification(
      ctx,
      user._id,
      args.notificationId,
    );
    if (notification) {
      await ctx.db.delete(notification._id);
    }
  },
});

/** Clear the whole feed — deletes every notification row for the user. */
export const clearAll = mutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return;
    }
    const throughCreatedAt = Date.now();
    const hasMore = await clearAllBatch(ctx, user._id, throughCreatedAt);
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.notifications.continueClearAll, {
        userId: user._id,
        throughCreatedAt,
      });
    }
  },
});

/** Continue a bulk clear operation in bounded transactions. */
export const continueClearAll = internalMutation({
  args: { userId: v.string(), throughCreatedAt: v.number() },
  handler: async (ctx, args): Promise<null> => {
    const hasMore = await clearAllBatch(
      ctx,
      args.userId,
      args.throughCreatedAt,
    );
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.notifications.continueClearAll,
        args,
      );
    }
    return null;
  },
});
