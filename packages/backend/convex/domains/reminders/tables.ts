import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Table definitions owned by the reminders domain, composed into schema.ts. */
export const reminderTables = {
  // The reminder ledger: one row per (event, minutes-offset) scheduled to
  // fire, materialised ahead of time from `events` plus defaults. It is the
  // single source of truth for *when* (the client and the server read the
  // same fireAtMs) and the dedupe record for *already fired* across both
  // delivery channels: flipping pending → sent is the mutex.
  reminderDeliveries: defineTable({
    userId: v.string(),
    eventId: v.id("events"),
    minutes: v.number(),
    fireAtMs: v.number(),
    // The event start the fireAt was derived from. A sync that moves the
    // event patches fireAtMs; the sweep re-checks this before firing.
    eventStartMs: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("skipped"),
    ),
    channel: v.optional(v.union(v.literal("client"), v.literal("server"))),
    sentAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    // Upsert / per-event diff / event-scoped cleanup (prefix on eventId).
    .index("by_event_and_minutes", ["eventId", "minutes"])
    // The global 1-minute sweep: pending rows due now, regardless of user.
    .index("by_status_and_fireAt", ["status", "fireAtMs"])
    // The client's `upcoming` query and user-scoped purge.
    .index("by_user_and_status_and_fireAt", ["userId", "status", "fireAtMs"])
    // Daily prune of settled rows.
    .index("by_fireAt", ["fireAtMs"]),
};
