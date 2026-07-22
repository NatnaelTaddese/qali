import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** A guest on an event. Mirrors the subset of Google's attendee object we keep;
 * `responseStatus` is "needsAction" | "declined" | "tentative" | "accepted".
 * Shared by the `events` table and the mutation validators that write to it. */
export const attendeeValidator = v.object({
  email: v.string(),
  displayName: v.optional(v.string()),
  responseStatus: v.optional(v.string()),
  organizer: v.optional(v.boolean()),
  self: v.optional(v.boolean()),
  optional: v.optional(v.boolean()),
});

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
    summaryOverride: v.optional(v.string()),
    backgroundColor: v.optional(v.string()),
    foregroundColor: v.optional(v.string()),
    primary: v.optional(v.boolean()),
    accessRole: v.optional(v.string()),
    timeZone: v.optional(v.string()),
    // Google's own Calendar UI visibility. This only seeds the local choice
    // when a calendar is first discovered; later local toggles are preserved.
    googleSelected: v.optional(v.boolean()),
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
    // Google's per-event color override ("1".."11"); absent means the event
    // inherits its calendar's color.
    colorId: v.optional(v.string()),
    // Google's `visibility`: "default" | "public" | "private" | "confidential".
    visibility: v.optional(v.string()),
    // Guests invited to the event, refreshed by every sync. See attendeeValidator.
    attendees: v.optional(v.array(attendeeValidator)),
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
