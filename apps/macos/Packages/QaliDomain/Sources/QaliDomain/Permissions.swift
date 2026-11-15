// Port of packages/domain/src/permissions.ts: what the signed-in user may do to
// one event — the same verdict the backend enforces. Google's permission model
// is spread across fields that disagree about their defaults, so read them
// only through this file.

/// Access roles that let us write to a calendar at all. Anything else is
/// read-only, so an unknown role fails closed.
public let writableAccessRoles: Set<String> = ["owner", "writer"]

/// Event types Google generates and maintains itself: the access role says
/// "writer" while Google rejects every edit.
let googleManagedEventTypes: Set<String> = ["birthday", "workingLocation", "fromGmail"]

/// The subset of an event the permission rules read. `nil` means the field
/// was absent on the row — which matters, because absence carries Google's
/// per-field defaults.
public struct EventAccessFacts: Sendable, Equatable {
  public struct Attendee: Sendable, Equatable {
    public var isSelf: Bool?
    public var responseStatus: String?
    public init(isSelf: Bool? = nil, responseStatus: String? = nil) {
      self.isSelf = isSelf
      self.responseStatus = responseStatus
    }
  }

  public struct Organizer: Sendable, Equatable {
    public var isSelf: Bool?
    public init(isSelf: Bool? = nil) { self.isSelf = isSelf }
  }

  public var attendees: [Attendee]?
  public var organizer: Organizer?
  public var guestsCanModify: Bool?
  public var guestsCanInviteOthers: Bool?
  public var guestsCanSeeOtherGuests: Bool?
  public var locked: Bool?
  public var eventType: String?
  public var providerSeriesId: String?

  public init(
    attendees: [Attendee]? = nil,
    organizer: Organizer? = nil,
    guestsCanModify: Bool? = nil,
    guestsCanInviteOthers: Bool? = nil,
    guestsCanSeeOtherGuests: Bool? = nil,
    locked: Bool? = nil,
    eventType: String? = nil,
    providerSeriesId: String? = nil
  ) {
    self.attendees = attendees
    self.organizer = organizer
    self.guestsCanModify = guestsCanModify
    self.guestsCanInviteOthers = guestsCanInviteOthers
    self.guestsCanSeeOtherGuests = guestsCanSeeOtherGuests
    self.locked = locked
    self.eventType = eventType
    self.providerSeriesId = providerSeriesId
  }
}

public struct EventCapabilities: Sendable, Equatable {
  /// Title, description, location, times, colour, all-day.
  public var canEdit: Bool
  public var canInviteOthers: Bool
  public var canSeeGuests: Bool
  /// Hard delete — cancels the event for every guest.
  public var canDelete: Bool
  /// Remove your own copy, leaving the organiser's untouched.
  public var canRemoveSelf: Bool
  public var canRespond: Bool
  public var canChangeRecurrence: Bool
  public var isOrganizer: Bool
  /// Your own RSVP: "needsAction" | "declined" | "tentative" | "accepted".
  public var selfResponse: String?
  /// Why editing is off, phrased for the user; nil when it isn't.
  public var readOnlyReason: String?
}

/// `accessRole` is that of the calendar holding the event; nil when we hold no
/// row for it (fails closed).
public func eventCapabilities(_ event: EventAccessFacts, calendarAccessRole: String?) -> EventCapabilities {
  let selfAttendee = event.attendees?.first { $0.isSelf == true }
  let writableCalendar = writableAccessRoles.contains(calendarAccessRole ?? "")
  let googleManaged = googleManagedEventTypes.contains(event.eventType ?? "")

  // A row synced before these fields were stored falls back to the calendar's
  // access role, the rule the app enforced before.
  let unknownProvenance = event.organizer == nil && event.attendees == nil
  let isOrganizer = event.organizer?.isSelf == true || (unknownProvenance && writableCalendar)

  // First matching rule wins: name the most fundamental obstacle.
  let readOnlyReason: String? =
    if googleManaged {
      "Google manages this event"
    } else if !writableCalendar {
      "You have read-only access to this calendar"
    } else if event.locked == true {
      "The organiser locked this event"
    } else if !isOrganizer && event.guestsCanModify != true {
      "Only the organiser can edit this event"
    } else {
      nil
    }
  let canEdit = readOnlyReason == nil

  return EventCapabilities(
    // guestsCanModify defaults to false (above); these two default to true.
    canEdit: canEdit,
    canInviteOthers: canEdit && (isOrganizer || (event.guestsCanInviteOthers ?? true)),
    canSeeGuests: !googleManaged && (isOrganizer || (event.guestsCanSeeOtherGuests ?? true)),
    canDelete: writableCalendar && !googleManaged && isOrganizer,
    canRemoveSelf: writableCalendar && !googleManaged && !isOrganizer && selfAttendee != nil,
    // Answering an invitation is not editing it; it still needs write access
    // to the calendar holding the copy we would patch.
    canRespond: writableCalendar && selfAttendee != nil,
    // Synced with singleEvents=true: a recurring row is one expanded instance
    // and carries no rule to edit.
    canChangeRecurrence: canEdit && event.providerSeriesId == nil,
    isOrganizer: isOrganizer,
    selfResponse: selfAttendee?.responseStatus,
    readOnlyReason: readOnlyReason
  )
}
