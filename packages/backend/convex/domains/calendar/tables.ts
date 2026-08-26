import { defineTable } from "convex/server";
import { v } from "convex/values";

import { eventDocValidator, sharedEventDocValidator } from "./validators";

/** Table definitions owned by the calendar domain, composed into schema.ts.
 * (`syncState` stays with the sync domain; these are the calendar-data tables.)
 *
 * TRANSITIONAL (deploy A): columns and indexes marked legacy are retained only
 * so pre-cutover rows validate and existing index builds survive the deploy.
 * No code reads or writes them; the final schema deletes them after the
 * provider-cutover wipe has replaced every row. */
export const calendarTables = {
  // One row per provider calendar in the user's calendar list. Holds display
  // metadata, the user's visibility choice, and the per-calendar sync cursor.
  calendars: defineTable({
    userId: v.string(),
    // TRANSITIONAL: both required at the final schema.
    connectionId: v.optional(v.id("calendarConnections")),
    providerCalendarId: v.optional(v.string()),
    summary: v.optional(v.string()),
    summaryOverride: v.optional(v.string()),
    backgroundColor: v.optional(v.string()),
    primary: v.optional(v.boolean()),
    accessRole: v.optional(v.string()),
    timeZone: v.optional(v.string()),
    // The provider's own calendar-UI visibility. This only seeds the local
    // choice when a calendar is first discovered; later local toggles are
    // preserved.
    providerSelected: v.optional(v.boolean()),
    selected: v.boolean(),
    // Opaque per-calendar provider cursor (Google sync token / Graph delta link).
    syncCursor: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    // Current full-resync generation for this calendar's `events` rows. Bumped
    // at the start of each full resync; the run stamps re-fetched rows with it
    // and sweeps rows carrying an older value. See syncOneConnectionCalendar.
    syncGeneration: v.optional(v.number()),
    // The full-resync attempt that reserved `syncGeneration`. The generation is
    // advanced durably at begin, not commit, so a crashed pass is never reused.
    syncGenerationAttemptId: v.optional(v.string()),
    // TRANSITIONAL: required at the final schema.
    isShared: v.optional(v.boolean()),
    // Legacy columns, unread and unwritten; deleted at the final schema.
    googleCalendarId: v.optional(v.string()),
    googleSelected: v.optional(v.boolean()),
    syncToken: v.optional(v.string()),
    foregroundColor: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    // Legacy index, no readers; deleted at the final schema.
    .index("by_user_and_googleCalendarId", ["userId", "googleCalendarId"])
    // Canonical connection-scoped calendar lookup.
    .index("by_connection_and_providerCalendarId", [
      "connectionId",
      "providerCalendarId",
    ]),

  // One row per synced personal calendar event. See eventDocValidator.
  events: defineTable(eventDocValidator)
    // User-prefix scans (prune, engagement, purge). The connection-keyed
    // indexes below cannot serve these — keep it.
    .index("by_user_and_start", ["userId", "startMs"])
    // Legacy indexes, no readers; deleted at the final schema.
    .index("by_user_and_calendar_and_end", ["userId", "calendarId", "endMs"])
    .index("by_user_and_calendar_and_googleEventId", [
      "userId",
      "calendarId",
      "googleEventId",
    ])
    // Canonical neutral lookups. Calendar identity is required in the key
    // because provider event ids may collide across calendars.
    .index("by_connection_and_localCalendarId_and_providerEventId", [
      "connectionId",
      "localCalendarId",
      "providerEventId",
    ])
    .index("by_connection_and_localCalendarId_and_providerSeriesId", [
      "connectionId",
      "localCalendarId",
      "providerSeriesId",
    ])
    .index("by_connection_and_localCalendarId_and_endMs", [
      "connectionId",
      "localCalendarId",
      "endMs",
    ]),

  // One physical copy of a *public* calendar's events (holidays, birthdays),
  // shared across every user who selects that calendar. Stored once rather
  // than per-user. No `userId`: the row belongs to the calendar, not a person.
  // See isSharedPublicCalendar in sharedPublicCalendars.ts.
  sharedEvents: defineTable(sharedEventDocValidator)
    // Legacy indexes, no readers; deleted at the final schema.
    .index("by_calendar_and_start", ["calendarId", "startMs"])
    .index("by_calendar_and_end", ["calendarId", "endMs"])
    .index("by_calendar_and_googleEventId", ["calendarId", "googleEventId"])
    .index("by_provider_and_providerCalendarId_and_providerEventId", [
      "provider",
      "providerCalendarId",
      "providerEventId",
    ])
    .index("by_provider_and_providerCalendarId_and_startMs", [
      "provider",
      "providerCalendarId",
      "startMs",
    ])
    .index("by_provider_and_providerCalendarId_and_endMs", [
      "provider",
      "providerCalendarId",
      "endMs",
    ]),

  // One row per shared public calendar: its user-independent sync cursor plus a
  // lease so exactly one user's sync refreshes it at a time.
  sharedCalendars: defineTable({
    // TRANSITIONAL: both required at the final schema.
    provider: v.optional(v.union(v.literal("google"), v.literal("microsoft"))),
    providerCalendarId: v.optional(v.string()),
    syncCursor: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    // Held while a sync runs; a second user finding a live lease skips its run.
    syncLeaseExpiresAt: v.optional(v.number()),
    syncAttemptId: v.optional(v.string()),
    syncGeneration: v.optional(v.number()),
    syncGenerationAttemptId: v.optional(v.string()),
    // Legacy columns, unread and unwritten; deleted at the final schema.
    googleCalendarId: v.optional(v.string()),
    syncToken: v.optional(v.string()),
  })
    // Legacy index, no readers; deleted at the final schema.
    .index("by_googleCalendarId", ["googleCalendarId"])
    .index("by_provider_and_providerCalendarId", [
      "provider",
      "providerCalendarId",
    ]),

  // One row per recurring master. Expanded event instances share this rule;
  // keeping it separately avoids duplicating it across every occurrence.
  recurringSeries: defineTable({
    userId: v.string(),
    // TRANSITIONAL: connectionId/localCalendarId/providerEventId/
    // providerUpdatedMs required at the final schema.
    connectionId: v.optional(v.id("calendarConnections")),
    localCalendarId: v.optional(v.id("calendars")),
    // The series master's provider event id.
    providerEventId: v.optional(v.string()),
    providerSeriesId: v.optional(v.string()),
    // The instance update time that this rule was fetched against. A newer
    // synced instance invalidates the cache and triggers one master refresh.
    providerUpdatedMs: v.optional(v.number()),
    recurrence: v.array(v.string()),
    // Legacy columns, unread and unwritten; deleted at the final schema.
    calendarId: v.optional(v.string()),
    googleEventId: v.optional(v.string()),
    sourceUpdatedMs: v.optional(v.number()),
  })
    // Per-user drain for account purge; the connection-keyed index below
    // cannot serve a user prefix.
    .index("by_user", ["userId"])
    // Legacy index, no readers; deleted at the final schema.
    .index("by_user_and_calendar_and_googleEventId", [
      "userId",
      "calendarId",
      "googleEventId",
    ])
    // Canonical calendar-keyed neutral lookup.
    .index("by_connection_and_localCalendarId_and_providerEventId", [
      "connectionId",
      "localCalendarId",
      "providerEventId",
    ]),
};
