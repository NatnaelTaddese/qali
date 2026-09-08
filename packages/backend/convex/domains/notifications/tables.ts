import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Table definitions owned by the notifications domain, composed into the root
 * schema. Kept beside the domain's logic so the whole feature reads in one place. */
export const notificationTables = {
  // One row per in-app notification for a host. Written by the events that a
  // host should hear about (a new booking request, an event reminder) and read by the
  // header notification bell. Dismissing a notification hard-deletes its row, so
  // the feed and this table never drift apart.
  notifications: defineTable({
    // Recipient. Matches `bookings.hostUserId` / the auth user's `_id`.
    userId: v.string(),
    type: v.union(
      v.literal("booking_requested"),
      v.literal("event_reminder"),
    ),
    title: v.string(),
    body: v.optional(v.string()),
    // The booking this notification points at, so a click can open its panel.
    bookingId: v.optional(v.id("bookings")),
    // The event a reminder points at, so a click can open it.
    eventId: v.optional(v.id("events")),
    read: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_user_and_created", ["userId", "createdAt"])
    .index("by_user_and_read", ["userId", "read"])
    .index("by_user_and_read_and_created", ["userId", "read", "createdAt"])
    // Lets a booking's lifecycle (accept / decline / expire) clear the request
    // notification it spawned.
    .index("by_booking", ["bookingId"]),
};
