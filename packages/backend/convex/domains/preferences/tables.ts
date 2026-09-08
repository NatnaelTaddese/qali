import { defineTable } from "convex/server";
import { v } from "convex/values";

/** The user-settable preference fields. Every one is optional: an absent
 * field means "automatic" (follow the browser, or the app default) — clearing
 * a preference removes the field rather than storing a sentinel. Shared by the
 * table definition, the update mutation's args, and the read DTO. */
export const preferenceFields = {
  // IANA zone used for new events and the booking page; absent = browser's.
  timeZone: v.optional(v.string()),
  // date-fns weekStartsOn convention: 0 = Sunday, 1 = Monday, 6 = Saturday.
  weekStartsOn: v.optional(v.union(v.literal(0), v.literal(1), v.literal(6))),
  timeFormat: v.optional(v.union(v.literal("12h"), v.literal("24h"))),
  defaultView: v.optional(
    v.union(v.literal("day"), v.literal("week"), v.literal("month")),
  ),
  // Where new events land when the create form has no explicit choice.
  defaultCalendarId: v.optional(v.id("calendars")),
  // Popup reminder offsets (minutes before start) for timed events that use
  // the default. Absent = automatic (the calendar's provider default, else 10
  // minutes); [] = no reminders.
  defaultReminderMinutes: v.optional(v.array(v.number())),
  // Same for all-day events, as minutes before local midnight of the start
  // date (900 = 09:00 the day before). Absent = automatic (900); [] = none.
  defaultAllDayReminderMinutes: v.optional(v.array(v.number())),
};

/** Table definitions owned by the preferences domain, composed into schema.ts. */
export const preferencesTables = {
  // One row per user holding display/behavior preferences. Theme is
  // deliberately NOT here: it stays client-side in next-themes localStorage so
  // it applies before auth resolves.
  userPreferences: defineTable({
    userId: v.string(),
    ...preferenceFields,
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
