import { v } from "convex/values";

/**
 * The event validators, owned by the calendar domain. They are declared here
 * (rather than in schema.ts) so both the schema and the action→mutation
 * boundaries that push a provider event across can share one definition without
 * a circular import back through schema.ts.
 */

/** An event id in either store: a personal `events` row or a read-only
 * public-calendar `sharedEvents` row. Read paths accept both; write paths
 * narrow to `v.id("events")` because shared events are never editable. */
export const eventIdArg = v.union(v.id("events"), v.id("sharedEvents"));

/** A guest on an event. Shared by the `events` table and the mutation
 * validators that write to it. */
export const attendeeValidator = v.object({
  email: v.string(),
  displayName: v.optional(v.string()),
  responseStatus: v.optional(
    v.union(
      v.literal("needsAction"),
      v.literal("accepted"),
      v.literal("tentative"),
      v.literal("declined"),
    ),
  ),
  organizer: v.optional(v.boolean()),
  self: v.optional(v.boolean()),
  optional: v.optional(v.boolean()),
});

/** A single person the provider names on an event — its organizer or its
 * creator. Unlike an attendee this is not a guest list entry, so it carries no
 * RSVP. `self` is set by the provider when the person is the calendar this copy
 * lives on, which makes it authoritative: never infer ownership by matching
 * emails. */
export const personValidator = v.object({
  email: v.optional(v.string()),
  displayName: v.optional(v.string()),
  self: v.optional(v.boolean()),
});

const providerAttendeeValidator = personValidator.extend({
  responseStatus: v.optional(
    v.union(
      v.literal("needsAction"),
      v.literal("accepted"),
      v.literal("tentative"),
      v.literal("declined"),
    ),
  ),
  organizer: v.optional(v.boolean()),
  optional: v.optional(v.boolean()),
});

/** Provider-neutral event returned by a calendar adapter. */
export const providerEventValidator = v.object({
  id: v.string(),
  calendarId: v.string(),
  summary: v.optional(v.string()),
  description: v.optional(v.string()),
  location: v.optional(v.string()),
  startMs: v.number(),
  endMs: v.number(),
  allDay: v.boolean(),
  timeZone: v.optional(v.string()),
  status: v.union(
    v.literal("confirmed"),
    v.literal("tentative"),
    v.literal("cancelled"),
  ),
  updatedMs: v.number(),
  htmlLink: v.optional(v.string()),
  color: v.optional(v.string()),
  visibility: v.optional(v.string()),
  busy: v.optional(v.boolean()),
  attendees: v.optional(v.array(providerAttendeeValidator)),
  attendeesOmitted: v.optional(v.boolean()),
  organizer: v.optional(personValidator),
  creator: v.optional(personValidator),
  guestsCanModify: v.optional(v.boolean()),
  guestsCanInviteOthers: v.optional(v.boolean()),
  guestsCanSeeOtherGuests: v.optional(v.boolean()),
  locked: v.optional(v.boolean()),
  eventType: v.optional(v.string()),
  recurrence: v.optional(v.array(v.string())),
  seriesId: v.optional(v.string()),
  originalOccurrenceStartMs: v.optional(v.number()),
  conference: v.optional(
    v.object({
      url: v.optional(v.string()),
      name: v.optional(v.string()),
      type: v.optional(v.string()),
    }),
  ),
});

/** Provider-neutral stored event fields shared by the personal `events` table
 * and the public-calendar `sharedEvents` table. Row identity (connection or
 * provider scoping) is added by the two doc validators below. */
export const storedEventBaseValidator = v.object({
  providerEventId: v.string(),
  providerUpdatedMs: v.number(),
  // Set on an expanded instance of a recurring series (we sync with single
  // instances, so we only ever hold instances, never the master).
  providerSeriesId: v.optional(v.string()),
  summary: v.optional(v.string()),
  description: v.optional(v.string()),
  location: v.optional(v.string()),
  startMs: v.number(),
  endMs: v.number(),
  allDay: v.boolean(),
  status: v.string(),
  htmlLink: v.optional(v.string()),
  // The provider's per-event color override (Google: palette key "1".."11");
  // absent means the event inherits its calendar's color.
  color: v.optional(v.string()),
  // "default" | "public" | "private" | "confidential".
  visibility: v.optional(v.string()),
  // Free/busy: absent means busy; `false` alone means free. Never read this
  // with a truthiness check.
  busy: v.optional(v.boolean()),
  // Guests invited to the event, refreshed by every sync. See attendeeValidator.
  attendees: v.optional(v.array(attendeeValidator)),
  // The provider sets this when it withheld part of the guest list, so a short
  // `attendees` array is not proof that the list is short.
  attendeesOmitted: v.optional(v.boolean()),

  // --- Who controls this event -------------------------------------------
  // `organizer.self` is the ownership test; `creator` differs when someone
  // scheduled on the organizer's behalf, and is only worth showing then.
  organizer: v.optional(personValidator),
  creator: v.optional(personValidator),
  // The three guest permissions. Each is tri-state on purpose: providers omit
  // them at their default, and the defaults disagree — absent guestsCanModify
  // means false, absent guestsCanInviteOthers/SeeOtherGuests mean true. Read
  // them only through the domain permission model, which encodes that.
  guestsCanModify: v.optional(v.boolean()),
  guestsCanInviteOthers: v.optional(v.boolean()),
  guestsCanSeeOtherGuests: v.optional(v.boolean()),
  // The provider forbids structural changes to a locked event, whoever you are.
  locked: v.optional(v.boolean()),
  // "default" | "birthday" | "outOfOffice" | "focusTime" | "workingLocation" |
  // "fromGmail". Several of these are provider-generated and reject edits even
  // on a calendar you own.
  eventType: v.optional(v.string()),
  conferenceUrl: v.optional(v.string()),
  conferenceName: v.optional(v.string()),
  conferenceType: v.optional(v.string()),
});

/** The stored personal-event row: the neutral base plus the local identity it
 * belongs to. `userId` is ours alone — it never round-trips to a provider. */
export const eventDocValidator = storedEventBaseValidator.extend({
  userId: v.string(),
  connectionId: v.id("calendarConnections"),
  localCalendarId: v.id("calendars"),
  // Monotonic per-calendar full-resync marker. A full resync stamps every
  // re-fetched row with a fresh generation, then deletes the rows still carrying
  // an older one — so the previous snapshot stays live for booking conflict
  // detection until the new one is fully written. See syncOneConnectionCalendar.
  // Left absent on incrementally-written rows; the next full resync re-stamps any
  // that still exist at the provider, so absence never causes a wrongful sweep.
  syncGeneration: v.optional(v.number()),
});

/** The stored shared-public-calendar event row. No `userId`: the row belongs
 * to the calendar, not a person. Scoped by provider + provider calendar id
 * because shared calendars exist independently of any connection. */
export const sharedEventDocValidator = storedEventBaseValidator.extend({
  provider: v.union(v.literal("google"), v.literal("microsoft")),
  providerCalendarId: v.string(),
  syncGeneration: v.optional(v.number()),
});
