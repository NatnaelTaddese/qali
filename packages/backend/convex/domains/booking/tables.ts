import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Table definitions owned by the booking domain, composed into schema.ts. */
export const bookingTables = {
  // One row per host: the public booking link plus its whole configuration.
  // A user has at most one page in this version, so the public page renders
  // from a single document read.
  bookingPages: defineTable({
    userId: v.string(),
    // The public path segment, normalized to [a-z0-9-]. Unique across users.
    slug: v.string(),
    // Copied from the auth user at save time: the public page must be readable
    // without touching the better-auth component (which also holds the email).
    displayName: v.string(),
    imageUrl: v.optional(v.string()),
    // The IANA zone `rules` and `availabilityOverrides` minutes are expressed
    // in, so a host's 9am stays 9am wherever the visitor happens to be.
    timeZone: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    slotMinutes: v.number(),
    // Kept clear on both sides of every busy event, so back-to-back bookings
    // against an existing meeting are impossible.
    bufferMinutes: v.number(),
    minNoticeMinutes: v.number(),
    // How far ahead the page offers slots at all.
    horizonDays: v.number(),
    // The weekly schedule. `weekday` is 0 (Sunday) through 6, and the bounds
    // are minutes from that day's midnight in `timeZone`.
    rules: v.array(
      v.object({
        weekday: v.number(),
        startMin: v.number(),
        endMin: v.number(),
      }),
    ),
    // False keeps the row (and the claimed slug) while the page reads as
    // missing to visitors.
    enabled: v.boolean(),
    // Routing target, nullable forever: the provider cutover nulls the pair
    // and the primary-target fallback self-heals. Always set or clear both
    // together — resolution throws when exactly one is present.
    targetConnectionId: v.optional(v.id("calendarConnections")),
    targetCalendarId: v.optional(v.id("calendars")),
  })
    .index("by_user", ["userId"])
    .index("by_slug", ["slug"])
    .index("by_targetConnectionId_and_targetCalendarId", [
      "targetConnectionId",
      "targetCalendarId",
    ]),

  // A single date's replacement for whatever the weekly rules say about that
  // weekday. An empty `intervals` blocks the day outright, which is why this is
  // a replacement rather than an addition.
  availabilityOverrides: defineTable({
    userId: v.string(),
    // "YYYY-MM-DD" as the date reads in the booking page's own time zone.
    dateKey: v.string(),
    intervals: v.array(v.object({ startMin: v.number(), endMin: v.number() })),
  }).index("by_user_and_date", ["userId", "dateKey"]),

  // One row per appointment request made through a public booking page.
  bookings: defineTable({
    hostUserId: v.string(),
    startMs: v.number(),
    endMs: v.number(),
    // The requester's zone, recorded so the host can see what time they booked
    // in. Display only — it never affects slot math.
    timeZone: v.string(),
    requesterName: v.string(),
    requesterEmail: v.string(),
    note: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("rejected"),
      v.literal("expired"),
    ),
    // Unguessable handle that lets the requester follow their own request
    // without an account. It is the only key that reads this row publicly.
    token: v.string(),
    // `connectionId` is the writable connection acceptance created the event
    // on; `providerEventId` is that event's provider id. Optional forever:
    // terminal bookings never re-resolve them.
    connectionId: v.optional(v.id("calendarConnections")),
    providerEventId: v.optional(v.string()),
    // Nullable forever, always as a pair (see bookingPages). The acceptance
    // target re-resolves through the operation ledger when absent.
    targetConnectionId: v.optional(v.id("calendarConnections")),
    targetCalendarId: v.optional(v.id("calendars")),
    decidedAt: v.optional(v.number()),
    // Stable idempotency key for one logical acceptance; keys the
    // calendarOperations ledger row across retries. Status remains pending
    // while the provider write is in flight so existing clients keep rendering
    // the request correctly and a lost response can be reconciled on retry.
    acceptOperationId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_host_and_start", ["hostUserId", "startMs"])
    .index("by_host_and_end", ["hostUserId", "endMs"])
    .index("by_host_and_status_and_start", ["hostUserId", "status", "startMs"])
    .index("by_status_and_end", ["status", "endMs"])
    .index("by_token", ["token"])
    .index("by_targetConnectionId_and_targetCalendarId_and_startMs", [
      "targetConnectionId",
      "targetCalendarId",
      "startMs",
    ]),
};
