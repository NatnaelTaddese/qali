import Foundation
import QaliDomain
import Testing
@testable import Qali

/// The edit form's save sends only what changed (the web's `diffEvent`).
@MainActor
struct EventPatchTests {
  let zone = WorkingZone(identifier: "Europe/Berlin")!
  /// Wed 18 Nov 2026, 10:00–11:00 in Berlin.
  let start = 1_795_510_800_000.0

  private func event(_ change: (inout CalendarEvent) -> Void = { _ in }) -> CalendarEvent {
    var event = CalendarEvent(id: "e1", startMs: start, endMs: start + 3_600_000, allDay: false, status: "confirmed")
    event.summary = "Standup"
    event.location = "Room 1"
    event.description = "<p>Notes</p>"
    event.color = "5"
    event.attendees = [
      EventAttendee(email: "me@example.com", responseStatus: "accepted", organizer: true, isSelf: true),
      EventAttendee(email: "Ana@example.com", displayName: "Ana", responseStatus: "tentative", optional: true),
    ]
    event.reminders = [EventReminder(method: "popup", minutes: 10), EventReminder(method: "email", minutes: 60)]
    change(&event)
    return event
  }

  @Test func anUntouchedFormSendsNothing() {
    let event = event()
    let draft = EventDraft(event: event, zone: zone)
    #expect(EventPatch(from: draft, to: draft, event: event, zone: zone).isEmpty)
  }

  @Test func emptiedFieldsClearWithNull() {
    let event = event()
    let initial = EventDraft(event: event, zone: zone)
    var next = initial
    next.location = "  "
    next.color = nil
    next.summary = " "
    let patch = EventPatch(from: initial, to: next, event: event, zone: zone)
    #expect(patch.location == .some(nil))
    #expect(patch.color == .some(nil))
    #expect(patch.summary == "(No title)")
    #expect(patch.description == nil)
    #expect(patch.times == nil)
    #expect(patch.attendees == nil)
  }

  @Test func aClearedDescriptionIsNull() {
    let event = event()
    let initial = EventDraft(event: event, zone: zone)
    var next = initial
    next.notesHTML = "<p></p>"
    next.notesPreview = ""
    #expect(EventPatch(from: initial, to: next, event: event, zone: zone).description == .some(nil))
  }

  @Test func movedTimesTravelTogether() {
    let event = event()
    let initial = EventDraft(event: event, zone: zone)
    var next = initial
    next.endMs += 1_800_000
    let patch = EventPatch(from: initial, to: next, event: event, zone: zone)
    #expect(patch.times == .init(startMs: start, endMs: start + 5_400_000, allDay: false))
  }

  @Test func anAllDayEventRoundTripsToUtcMidnights() {
    // 18–19 Nov, stored as UTC midnights with an exclusive end.
    let day = 1_795_478_400_000.0
    let event = event { $0.allDay = true; $0.startMs = day; $0.endMs = day + 2 * msPerDay }
    let draft = EventDraft(event: event, zone: zone)
    let times = draft.eventTimes(zone: zone)
    #expect(times.startMs == day)
    #expect(times.endMs == day + 2 * msPerDay)
    #expect(EventPatch(from: draft, to: draft, event: event, zone: zone).isEmpty)
  }

  @Test func changedGuestsKeepTheirAnswers() {
    let event = event()
    let initial = EventDraft(event: event, zone: zone)
    var next = initial
    next.guests.append(DraftGuest(email: "new@example.com"))
    let attendees = EventPatch(from: initial, to: next, event: event, zone: zone).attendees
    #expect(attendees?.count == 3)
    #expect(attendees?[0].responseStatus == "accepted")
    #expect(attendees?[1] == .init(email: "Ana@example.com", displayName: "Ana", responseStatus: "tentative", optional: true))
    #expect(attendees?[2].responseStatus == nil)
  }

  @Test func remindersKeepEmailOnesAndCanRevertToDefault() {
    let event = event()
    let initial = EventDraft(event: event, zone: zone)
    #expect(initial.reminders == [10])

    var next = initial
    next.reminders = [30, 10]
    let patch = EventPatch(from: initial, to: next, event: event, zone: zone)
    #expect(
      patch.reminders == .some([
        EventReminder(method: "popup", minutes: 10),
        EventReminder(method: "popup", minutes: 30),
        EventReminder(method: "email", minutes: 60),
      ])
    )

    next.reminders = nil
    #expect(EventPatch(from: initial, to: next, event: event, zone: zone).reminders == .some(nil))
  }

  @Test func meetAndPrivacyToggles() {
    let event = event { $0.conferenceType = "hangoutsMeet" }
    let initial = EventDraft(event: event, zone: zone)
    #expect(initial.meet)
    var next = initial
    next.meet = false
    next.isPrivate = true
    next.busy = false
    let patch = EventPatch(from: initial, to: next, event: event, zone: zone)
    #expect(patch.meet == false)
    #expect(patch.visibility == .some("private"))
    #expect(patch.busy == false)
  }

  @Test func aSeriesRepeatChangesOrStops() {
    let event = event { $0.providerSeriesId = "series-1" }
    var initial = EventDraft(event: event, zone: zone)
    initial.repeatRule = .weekly(on: .we)
    var daily = initial
    daily.repeatRule = .daily()
    #expect(EventPatch(from: initial, to: daily, event: event, zone: zone).recurrence == ["RRULE:FREQ=DAILY"])
    var stopped = initial
    stopped.repeatRule = nil
    #expect(EventPatch(from: initial, to: stopped, event: event, zone: zone).recurrence == [])
    #expect(EventPatch(from: initial, to: initial, event: event, zone: zone).isEmpty)
  }
}
