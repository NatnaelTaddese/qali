import Testing
@testable import QaliDomain

// Ports of calendars.test.ts and permissions.test.ts.

@Suite struct CalendarsTests {
  @Test func displayNamePrefersOverrideThenSummaryThenCalendarId() {
    #expect(calendarDisplayName(providerCalendarId: "primary@example.com", summary: "Primary", summaryOverride: "My calendar") == "My calendar")
    #expect(calendarDisplayName(providerCalendarId: "team@example.com", summary: "Team", summaryOverride: nil) == "Team")
    #expect(calendarDisplayName(providerCalendarId: "fallback@example.com", summary: nil, summaryOverride: nil) == "fallback@example.com")
  }

  @Test func onlyOwnersAndWritersCanWriteUnknownRolesFailClosed() {
    #expect(isWritableCalendar(accessRole: "owner"))
    #expect(isWritableCalendar(accessRole: "writer"))
    #expect(!isWritableCalendar(accessRole: "reader"))
    #expect(!isWritableCalendar(accessRole: nil))
  }
}

@Suite struct EventCapabilitiesTests {
  let owned = "owner"
  let sharedReadOnly = "reader"
  /// An event you organised on your own calendar.
  let mine = EventAccessFacts(organizer: .init(isSelf: true))

  @Test func anEventYouOrganiseIsFullyYours() {
    let caps = eventCapabilities(mine, calendarAccessRole: owned)
    #expect(caps.canEdit)
    #expect(caps.isOrganizer)
    #expect(caps.canDelete)
    #expect(caps.canInviteOthers)
    #expect(caps.readOnlyReason == nil)
    #expect(!caps.canRespond)
    #expect(!caps.canRemoveSelf)
  }

  @Test func aReadOnlyCalendarBlocksEverything() {
    let caps = eventCapabilities(mine, calendarAccessRole: sharedReadOnly)
    #expect(!caps.canEdit)
    #expect(!caps.canDelete)
    #expect(caps.readOnlyReason == "You have read-only access to this calendar")
  }

  @Test func anUnsyncedCalendarFailsClosed() {
    #expect(!eventCapabilities(mine, calendarAccessRole: nil).canEdit)
  }

  @Test func aBirthdayOnYourOwnCalendarIsStillNotEditable() {
    var birthday = mine
    birthday.eventType = "birthday"
    let caps = eventCapabilities(birthday, calendarAccessRole: owned)
    #expect(!caps.canEdit)
    #expect(!caps.canDelete)
    #expect(!caps.canSeeGuests)
    #expect(caps.readOnlyReason == "Google manages this event")
  }

  @Test func aGuestCannotEditUnlessGuestsCanModifySaysSo() {
    var invited = EventAccessFacts(
      attendees: [.init(isSelf: true, responseStatus: "needsAction")],
      organizer: .init(isSelf: false)
    )
    let caps = eventCapabilities(invited, calendarAccessRole: owned)
    #expect(!caps.canEdit)
    #expect(caps.readOnlyReason == "Only the organiser can edit this event")
    #expect(caps.canRespond)
    #expect(caps.selfResponse == "needsAction")
    #expect(caps.canRemoveSelf)
    #expect(!caps.canDelete)

    invited.guestsCanModify = true
    #expect(eventCapabilities(invited, calendarAccessRole: owned).canEdit)
  }

  @Test func guestFlagsApplyGooglesPerFieldDefaultsWhenAbsent() {
    var invited = EventAccessFacts(
      attendees: [.init(isSelf: true)], organizer: .init(isSelf: false), guestsCanModify: true
    )
    let permissive = eventCapabilities(invited, calendarAccessRole: owned)
    #expect(permissive.canInviteOthers)
    #expect(permissive.canSeeGuests)

    invited.guestsCanInviteOthers = false
    invited.guestsCanSeeOtherGuests = false
    let restricted = eventCapabilities(invited, calendarAccessRole: owned)
    #expect(!restricted.canInviteOthers)
    #expect(!restricted.canSeeGuests)
    #expect(restricted.canEdit)
  }

  @Test func aLockedEventCanStillBeAnswered() {
    var locked = mine
    locked.locked = true
    locked.attendees = [.init(isSelf: true)]
    let caps = eventCapabilities(locked, calendarAccessRole: owned)
    #expect(!caps.canEdit)
    #expect(caps.readOnlyReason == "The organiser locked this event")
    #expect(caps.canRespond)
  }

  @Test func aRecurringInstanceCarriesNoRuleToChange() {
    var instance = mine
    instance.providerSeriesId = "series-1"
    #expect(!eventCapabilities(instance, calendarAccessRole: owned).canChangeRecurrence)
    #expect(eventCapabilities(mine, calendarAccessRole: owned).canChangeRecurrence)
  }

  @Test func aRowPredatingTheSyncKeepsTheOldBehaviour() {
    let legacy = EventAccessFacts()
    #expect(eventCapabilities(legacy, calendarAccessRole: owned).canEdit)
    #expect(eventCapabilities(legacy, calendarAccessRole: owned).isOrganizer)
    #expect(!eventCapabilities(legacy, calendarAccessRole: sharedReadOnly).canEdit)
  }
}
