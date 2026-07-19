import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per user tracking incremental-sync state for Google data.
  // Per-calendar sync tokens live on the `calendars` table.
  syncState: defineTable({
    userId: v.string(),
    contactsSyncToken: v.optional(v.string()),
    lastContactsSyncAt: v.optional(v.number()),
    status: v.union(
      v.literal("idle"),
      v.literal("syncing"),
      v.literal("error"),
    ),
    lastError: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  // One row per Google calendar in the user's CalendarList. Holds display
  // metadata, the user's visibility choice, and the per-calendar sync token.
  calendars: defineTable({
    userId: v.string(),
    googleCalendarId: v.string(),
    summary: v.optional(v.string()),
    backgroundColor: v.optional(v.string()),
    foregroundColor: v.optional(v.string()),
    primary: v.optional(v.boolean()),
    accessRole: v.optional(v.string()),
    timeZone: v.optional(v.string()),
    selected: v.boolean(),
    syncToken: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_googleCalendarId", ["userId", "googleCalendarId"]),

  // One row per synced Google Calendar event.
  events: defineTable({
    userId: v.string(),
    googleEventId: v.string(),
    calendarId: v.string(),
    summary: v.optional(v.string()),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    startMs: v.number(),
    endMs: v.number(),
    allDay: v.boolean(),
    status: v.string(),
    htmlLink: v.optional(v.string()),
    googleUpdatedMs: v.number(),
  })
    .index("by_user_and_start", ["userId", "startMs"])
    .index("by_user_and_calendar", ["userId", "calendarId"])
    .index("by_user_and_calendar_and_googleEventId", [
      "userId",
      "calendarId",
      "googleEventId",
    ]),

  // One row per synced Google contact (People API connection).
  contacts: defineTable({
    userId: v.string(),
    resourceName: v.string(),
    displayName: v.optional(v.string()),
    emails: v.array(v.string()),
    phones: v.array(v.string()),
    photoUrl: v.optional(v.string()),
    googleEtag: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_resourceName", ["userId", "resourceName"]),
});
