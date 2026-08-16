/**
 * Notifications domain model: the plain data helpers and constants the queries,
 * mutations, and other domains (booking) build on. No Convex function wrappers
 * live here — those stay at the root facade `notifications.ts`.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

/** How many notifications the bell shows at once. */
export const MAX_NOTIFICATIONS = 30;
/** Enough to render "9+" without counting the whole table. */
export const UNREAD_CAP = 10;
/** Keep bulk actions comfortably inside one Convex transaction. */
export const BULK_BATCH_SIZE = 100;

export type NotificationWithBooking = Doc<"notifications"> & {
  booking: Doc<"bookings"> | null;
};

/** Keep unread rows reachable while filling the rest of a bounded feed with
 * recent history. Rows present in both inputs are emitted only once. */
export function selectVisibleNotifications<T extends { _id: string }>(
  unread: readonly T[],
  recent: readonly T[],
  limit: number,
): T[] {
  const unreadIds = new Set(unread.map((row) => row._id));
  return [
    ...unread,
    ...recent.filter((row) => !unreadIds.has(row._id)),
  ].slice(0, limit);
}

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
export async function ownedNotification(
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

export async function markAllReadBatch(
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

export async function clearAllBatch(
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
