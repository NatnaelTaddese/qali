import Foundation
import QaliDomain

// Decodable mirrors of the Convex query results the app reads. Field names
// follow the backend validators (packages/backend/convex/domains/calendar/
// validators.ts and queries.ts); every optional validator field is optional
// here, and `v.number()` values are `Double` (Convex sends float64 as plain
// JSON numbers).

/// A guest on an event (`attendeeValidator`).
nonisolated struct EventAttendee: Codable, Hashable, Sendable {
  var email: String
  var displayName: String?
  /// "needsAction" | "accepted" | "tentative" | "declined".
  var responseStatus: String?
  var organizer: Bool?
  var isSelf: Bool?
  var optional: Bool?

  enum CodingKeys: String, CodingKey {
    case email, displayName, responseStatus, organizer, optional
    case isSelf = "self"
  }
}

/// An organizer or creator (`personValidator`).
nonisolated struct EventPerson: Codable, Hashable, Sendable {
  var email: String?
  var displayName: String?
  var isSelf: Bool?

  enum CodingKeys: String, CodingKey {
    case email, displayName
    case isSelf = "self"
  }
}

nonisolated struct EventReminder: Codable, Hashable, Sendable {
  /// "popup" | "email".
  var method: String
  var minutes: Double
}

/// One row of `listEventsInRange`: a synced `events` row, or a public-calendar
/// `sharedEvents` row mapped into the same shape (`sharedAsEvent`).
nonisolated struct CalendarEvent: Codable, Hashable, Identifiable, Sendable, CalendarEventLike, ColorableEventLike {
  var id: String
  var startMs: Double
  var endMs: Double
  var allDay: Bool
  /// The IANA zone the provider says the event is set in; nil when it named
  /// none (all-day events, or one that follows its calendar's zone).
  var timeZone: String?
  var summary: String?
  var description: String?
  var location: String?
  var status: String
  var htmlLink: String?
  /// Google palette key "1"…"11"; nil inherits the calendar's colour.
  var color: String?
  /// "default" | "public" | "private" | "confidential".
  var visibility: String?
  /// Absent means busy; only an explicit `false` means free.
  var busy: Bool?
  var attendees: [EventAttendee]?
  var attendeesOmitted: Bool?
  var organizer: EventPerson?
  var creator: EventPerson?
  var guestsCanModify: Bool?
  var guestsCanInviteOthers: Bool?
  var guestsCanSeeOtherGuests: Bool?
  var locked: Bool?
  var eventType: String?
  var providerSeriesId: String?
  var conferenceUrl: String?
  var conferenceName: String?
  var conferenceType: String?
  /// nil = the calendar's default reminders apply; [] = none.
  var reminders: [EventReminder]?
  var localCalendarId: String?
  var connectionId: String?

  enum CodingKeys: String, CodingKey {
    case id = "_id"
    case startMs, endMs, allDay, timeZone, summary, description, location, status, htmlLink, color
    case visibility, busy, attendees, attendeesOmitted, organizer, creator
    case guestsCanModify, guestsCanInviteOthers, guestsCanSeeOtherGuests, locked, eventType
    case providerSeriesId, conferenceUrl, conferenceName, conferenceType, reminders
    case localCalendarId, connectionId
  }

  /// The fields the shared permission rules read.
  var accessFacts: EventAccessFacts {
    EventAccessFacts(
      attendees: attendees?.map { .init(isSelf: $0.isSelf, responseStatus: $0.responseStatus) },
      organizer: organizer.map { .init(isSelf: $0.isSelf) },
      guestsCanModify: guestsCanModify,
      guestsCanInviteOthers: guestsCanInviteOthers,
      guestsCanSeeOtherGuests: guestsCanSeeOtherGuests,
      locked: locked,
      eventType: eventType,
      providerSeriesId: providerSeriesId
    )
  }
}

/// One row of the `listCalendars` DTO.
nonisolated struct CalendarListItem: Codable, Hashable, Identifiable, Sendable {
  var id: String
  var connectionId: String?
  /// "google" | "microsoft".
  var provider: String?
  var providerCalendarId: String?
  var summary: String?
  var summaryOverride: String?
  var backgroundColor: String?
  var primary: Bool?
  var accessRole: String?
  var timeZone: String?
  var selected: Bool?
  var providerSelected: Bool?
  var isShared: Bool?

  enum CodingKeys: String, CodingKey {
    case id = "_id"
    case connectionId, provider, providerCalendarId, summary, summaryOverride, backgroundColor
    case primary, accessRole, timeZone, selected, providerSelected, isShared
  }

  var displayName: String {
    calendarDisplayName(providerCalendarId: providerCalendarId, summary: summary, summaryOverride: summaryOverride)
  }

  var colorKey: EventPaletteKey {
    calendarColorKey(id: id, backgroundColor: backgroundColor)
  }

  var isWritable: Bool { isWritableCalendar(accessRole: accessRole) }
}

/// One row of `listConnections`: a connected provider account.
nonisolated struct ConnectionListItem: Decodable, Hashable, Identifiable, Sendable {
  var id: String
  /// The account's address, which is what the picker labels a group with.
  var providerAccountId: String?
  var createdAt: Double
  /// "google" | "microsoft".
  var provider: String?
  /// "active" once connected; anything else is broken or revoked.
  var status: String?
  /// The account's display name and photo, stamped after the first sync.
  var providerAccountName: String?
  var providerAccountImageUrl: String?
  var contactsEnabled: Bool?
  var lastError: String?
  var syncIntervalMs: Double?
  var lastSyncAt: Double?

  enum CodingKeys: String, CodingKey {
    case id = "_id"
    case providerAccountId, createdAt, provider, status
    case providerAccountName, providerAccountImageUrl, contactsEnabled, lastError, syncIntervalMs, lastSyncAt
  }
}

/// Calendars under one connected account. `label` is nil while there is a
/// single account, where a heading would only repeat the obvious.
nonisolated struct CalendarGroup: Identifiable, Hashable, Sendable {
  var id: String
  var label: String?
  var calendars: [CalendarListItem]
}

/// Port of the web's `groupCalendarsByAccount` (components/calendar/lib.ts).
nonisolated func groupCalendarsByAccount(
  _ calendars: [CalendarListItem],
  connections: [ConnectionListItem]
) -> [CalendarGroup] {
  guard connections.count > 1 else {
    return calendars.isEmpty ? [] : [CalendarGroup(id: "all", label: nil, calendars: calendars)]
  }
  let ordered = connections.sorted { $0.createdAt < $1.createdAt }
  let known = Set(ordered.map(\.id))
  var groups = ordered.map { connection in
    CalendarGroup(
      id: connection.id,
      label: connection.providerAccountId ?? "Connected account",
      calendars: calendars.filter { $0.connectionId == connection.id }
    )
  }
  let orphans = calendars.filter { $0.connectionId.map { !known.contains($0) } ?? true }
  if !orphans.isEmpty {
    groups.append(CalendarGroup(id: "other", label: "Other", calendars: orphans))
  }
  return groups.filter { !$0.calendars.isEmpty }
}

/// One row of the notifications feed (`domains/notifications/queries:list`).
nonisolated struct NotificationRow: Decodable, Hashable, Identifiable, Sendable {
  var id: String
  /// "booking_requested" | "event_reminder".
  var type: String
  var title: String
  var body: String?
  var read: Bool
  var createdAt: Double
  /// The reminded event (the whole document); nil once it is gone. Opening
  /// the row shows it in the island and reveals it on the grid.
  var event: CalendarEvent?
  /// The request a "booking_requested" row is about (the whole document);
  /// opening the row shows it in the island.
  var booking: Booking?

  enum CodingKeys: String, CodingKey {
    case id = "_id"
    case type, title, body, read, createdAt, event, booking
  }
}

/// The `getMyPreferences` DTO. Every field is optional: absent means
/// "automatic" and the client resolves it (see `ResolvedPreferences`).
nonisolated struct StoredPreferences: Codable, Hashable, Sendable {
  var timeZone: String?
  /// The time rail's other zones, in order; nil when never set.
  var otherTimeZones: [String]?
  /// date-fns convention: 0 = Sunday, 1 = Monday, 6 = Saturday.
  var weekStartsOn: Double?
  /// "12h" | "24h".
  var timeFormat: String?
  /// "day" | "week" | "month".
  var defaultView: String?
  var defaultCalendarId: String?
  var defaultReminderMinutes: [Double]?
  var defaultAllDayReminderMinutes: [Double]?
  /// The assistant's auto mode; nil or false = every change waits.
  var assistantAutoApply: Bool?
}

/// Stored preferences with every "automatic" field replaced by its default,
/// as apps/native/contexts/preferences-context.tsx resolves them.
nonisolated struct ResolvedPreferences: Hashable, Sendable {
  var weekStartsOn: WeekStart
  var use24h: Bool
  /// The working zone every calendar time is cut and labelled in.
  var zone: WorkingZone
  var raw: StoredPreferences

  init(_ raw: StoredPreferences) {
    self.raw = raw
    weekStartsOn = raw.weekStartsOn.flatMap { WeekStart(rawValue: Int($0)) } ?? defaultWeekStart
    use24h = raw.timeFormat == "24h"
    zone = WorkingZone.resolve(preference: raw.timeZone)
  }
}

/// One row of `listPeople`: the user's people directory (saved contacts,
/// other contacts and people met in events), most-met first.
nonisolated struct PersonRow: Decodable, Hashable, Sendable {
  var email: String
  var displayName: String?
  var photoUrl: String?
}
