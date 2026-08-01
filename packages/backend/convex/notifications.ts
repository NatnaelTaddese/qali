/**
 * In-app notifications for a host: the events worth surfacing (currently a new
 * booking request) write a row here, and the header notification bell reads it.
 *
 * Two deliberate shapes: `read` drives the unread badge (marking read keeps the
 * row), while dismissal is a hard `delete` — clearing a notification removes it
 * from the table so the feed and the DB never drift apart.
 */

import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { authComponent } from "./auth";

/** How many notifications the bell shows at once. */
const MAX_NOTIFICATIONS = 30;
/** Enough to render "9+" without counting the whole table. */
const UNREAD_CAP = 10;

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

/** Most recent notifications for the signed-in user, newest first. Booking
 * notifications carry their booking doc so a click can open the dock panel. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<NotificationWithBooking[]> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_user_and_created", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(MAX_NOTIFICATIONS);
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

/** Mark every unread notification read (clears the badge). */
export const markAllRead = mutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return;
    }
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_and_read", (q) =>
        q.eq("userId", user._id).eq("read", false),
      )
      .collect();
    await Promise.all(unread.map((row) => ctx.db.patch(row._id, { read: true })));
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
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_user_and_created", (q) => q.eq("userId", user._id))
      .collect();
    await Promise.all(rows.map((row) => ctx.db.delete(row._id)));
  },
});
