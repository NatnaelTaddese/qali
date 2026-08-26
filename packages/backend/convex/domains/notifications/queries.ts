/** Read side of the notifications domain: plain handlers plus the canonical
 * `query` registrations. The root `notifications.ts` facade re-exports the
 * registered objects so the legacy `api.notifications.*` paths stay live. */

import { query, type QueryCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  MAX_NOTIFICATIONS,
  selectVisibleNotifications,
  UNREAD_CAP,
  type NotificationWithBooking,
} from "./model";

/** Unread notifications first, followed by the most recent read history.
 * Prioritizing unread rows keeps every unread item reachable through the fixed
 * feed window as earlier rows are read. Booking notifications carry their
 * booking doc so a click can open the dock panel. */
export async function listHandler(
  ctx: QueryCtx,
): Promise<NotificationWithBooking[]> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return [];
  }
  const unread = await ctx.db
    .query("notifications")
    .withIndex("by_user_and_read_and_created", (q) =>
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
  const rows = selectVisibleNotifications(unread, recent, MAX_NOTIFICATIONS);
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      booking: row.bookingId ? await ctx.db.get(row.bookingId) : null,
    })),
  );
}

export const list = query({
  args: {},
  handler: (ctx) => listHandler(ctx),
});

/** Unread count for the badge, capped so it never scans the whole table. */
export async function unreadCountHandler(ctx: QueryCtx): Promise<number> {
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
}

export const unreadCount = query({
  args: {},
  handler: (ctx) => unreadCountHandler(ctx),
});
