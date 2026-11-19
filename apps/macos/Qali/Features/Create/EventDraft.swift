import Foundation
import QaliDomain

/// Everything the create form edits (the web's `EventFormValue`). The times
/// are working values: timed instants even for an all-day event, whose end is
/// its last day rather than the exclusive day after, so the pickers and the
/// ghost on the grid keep working; `eventTimes` converts them at submit.
nonisolated struct EventDraft: Equatable, Sendable {
  var summary = ""
  /// The description as the HTML subset Google keeps (`DescriptionHTML`),
  /// nil when there is none.
  var notesHTML: String?
  /// The description on one line, for the form's preview.
  var notesPreview = ""
  var location = ""
  /// A Google Meet instead of a place: the "Where" row is one or the other.
  var meet = false
  var startMs: Double
  var endMs: Double
  var allDay = false
  var isPrivate = false
  /// Busy is the provider default.
  var busy = true
  /// Google colour "1"…"11"; nil inherits the calendar's.
  var color: String?
  /// Nil goes to the default calendar (see `CalendarData.defaultCalendar`).
  var calendarId: String?
  var guests: [DraftGuest] = []
  /// Nil does not repeat.
  var repeatRule: Recurrence?
  /// Popup offsets in minutes. Nil is the calendar's default; empty is none.
  var reminders: [Double]?

  init(startMs: Double, endMs: Double) {
    self.startMs = startMs
    self.endMs = endMs
  }

  var isValid: Bool { endMs > startMs }

  /// The form filled from an existing event (the web's `formValueFromEvent`).
  /// An all-day event's times become working-zone midnights of its first and
  /// last day. Repeating rows are expanded instances that carry no rule, so
  /// the repeat stays unset.
  init(event: CalendarEvent, zone: WorkingZone) {
    if event.allDay {
      startMs = fromUtcMidnight(event.startMs, zone: zone)
      endMs = fromUtcMidnight(event.endMs - msPerDay, zone: zone)
    } else {
      startMs = event.startMs
      endMs = event.endMs
    }
    summary = event.summary ?? ""
    notesHTML = event.description.flatMap { $0.isEmpty ? nil : $0 }
    location = event.location ?? ""
    meet = event.conferenceType == "hangoutsMeet"
    allDay = event.allDay
    isPrivate = event.visibility == "private"
    busy = event.busy != false
    color = event.color
    calendarId = event.localCalendarId
    guests = (event.attendees ?? []).map {
      DraftGuest(email: $0.email, displayName: $0.displayName, isSelf: $0.isSelf == true)
    }
    reminders = event.reminders.map { $0.filter { $0.method == "popup" }.map(\.minutes).sorted() }
  }

  /// The instants sent to the provider. All-day events are date-only: UTC
  /// midnight of the first day, as read in the working zone, and the
  /// exclusive UTC midnight after the last one.
  func eventTimes(zone: WorkingZone) -> (startMs: Double, endMs: Double) {
    guard allDay else { return (startMs, endMs) }
    return (utcMidnight(startMs, zone: zone), utcMidnight(endMs, zone: zone) + msPerDay)
  }

}

/// UTC midnight of an instant's working-zone calendar day: the instant
/// Google's all-day date strings map to.
nonisolated func utcMidnight(_ ms: Double, zone: WorkingZone) -> Double {
  let parts = zone.calendar.dateComponents([.year, .month, .day], from: Date(ms: ms))
  var utc = Calendar(identifier: .gregorian)
  utc.timeZone = .gmt
  return (utc.date(from: parts) ?? Date(ms: ms)).ms
}

/// The first `durationMs` slot on the day that no timed event overlaps (the
/// web's `nextFreeSlot`): from 9:00, or on today from the next snap after
/// now, stepping past whatever is in the way. A full day falls back to the
/// last slot before midnight.
nonisolated func nextFreeSlot(
  dayStartMs: Double,
  events: [CalendarEvent],
  nowMs: Double,
  durationMs: Double = defaultEventDurationMs
) -> (startMs: Double, endMs: Double) {
  let nineAm = dayStartMs + defaultEventStartMinutes * msPerMinute
  let isToday = nowMs >= dayStartMs && nowMs < dayStartMs + msPerDay
  let fromNow = (nowMs / snapMs).rounded(.up) * snapMs
  var start = isToday ? max(nineAm, fromNow) : nineAm
  let lastStart = dayStartMs + msPerDay - durationMs
  let timed = events.filter { !$0.allDay }.sorted { $0.startMs < $1.startMs }
  while start <= lastStart {
    let end = start + durationMs
    guard let clash = timed.first(where: { $0.startMs < end && $0.endMs > start }) else {
      return (start, end)
    }
    start = max(start + snapMs, (clash.endMs / snapMs).rounded(.up) * snapMs)
  }
  let fallback = ((lastStart - dayStartMs) / snapMs).rounded(.down) * snapMs + dayStartMs
  return (fallback, fallback + durationMs)
}

/// Someone invited to the event. The photo is only for the chip; `isSelf`
/// marks the signed-in user's own row on an edited event.
nonisolated struct DraftGuest: Hashable, Sendable {
  var email: String
  var displayName: String?
  var photoUrl: String?
  var isSelf = false
}

// MARK: - Edit

/// What an edit changes (the web's `diffEvent`): only the fields the user
/// touched. Google reads an absent field as "leave it" and clears one only on
/// an explicit null, so a field emptied here is `.some(nil)`.
nonisolated struct EventPatch: Equatable, Sendable {
  struct Times: Equatable, Sendable {
    var startMs: Double
    var endMs: Double
    var allDay: Bool
  }

  struct Attendee: Equatable, Sendable {
    var email: String
    var displayName: String?
    var responseStatus: String?
    var optional: Bool?
  }

  var summary: String?
  var description: String??
  var location: String??
  var color: String??
  var visibility: String??
  var busy: Bool?
  /// True mints a Google Meet, false clears the call.
  var meet: Bool?
  var times: Times?
  var recurrence: [String]?
  /// A list replaces the popups (email reminders kept); `.some(nil)` goes back
  /// to the calendar's default.
  var reminders: [EventReminder]??
  var attendees: [Attendee]?

  var isEmpty: Bool { self == EventPatch() }

  /// The changes from `initial` (the form as it opened) to `next`, for
  /// `event`. `zone` is the working zone the times were composed in.
  init(from initial: EventDraft, to next: EventDraft, event: CalendarEvent, zone: WorkingZone) {
    if next.summary != initial.summary {
      let title = next.summary.trimmingCharacters(in: .whitespacesAndNewlines)
      summary = title.isEmpty ? "(No title)" : title
    }
    if next.notesHTML != initial.notesHTML {
      let html = next.notesHTML ?? ""
      description = .some(next.notesPreview.isEmpty || html.isEmpty ? nil : html)
    }
    if next.location != initial.location {
      let place = next.location.trimmingCharacters(in: .whitespacesAndNewlines)
      location = .some(place.isEmpty ? nil : place)
    }
    if next.color != initial.color { color = .some(next.color) }
    if next.isPrivate != initial.isPrivate { visibility = .some(next.isPrivate ? "private" : nil) }
    if next.busy != initial.busy { busy = next.busy }
    if next.meet != initial.meet { meet = next.meet }

    // Both ends travel together, with all-day, which changes how both are written.
    let times = next.eventTimes(zone: zone)
    let before = initial.eventTimes(zone: zone)
    if times != before || next.allDay != initial.allDay {
      self.times = Times(startMs: times.startMs, endMs: times.endMs, allDay: next.allDay)
    }

    if let rule = next.repeatRule, rule != initial.repeatRule {
      recurrence = rule.rrule(zone: zone)
    }

    if Self.reminderSet(next.reminders) != Self.reminderSet(initial.reminders) {
      reminders = .some(
        next.reminders.map { popups in
          // Email reminders aren't shown in the form; keep the event's.
          let emails = (event.reminders ?? []).filter { $0.method != "popup" }
          let chosen = Array(Set(popups)).sorted().map { EventReminder(method: "popup", minutes: $0) }
          return Array((chosen + emails).prefix(5))
        }
      )
    }

    let guestsChanged =
      next.guests.count != initial.guests.count
      || zip(next.guests, initial.guests).contains { $0.email.lowercased() != $1.email.lowercased() }
    if guestsChanged {
      // The list is replaced wholesale: carry each guest's answer across, or
      // saving would reset everyone to "needs action".
      let answered = Dictionary(
        (event.attendees ?? []).map { ($0.email.lowercased(), $0) },
        uniquingKeysWith: { first, _ in first }
      )
      attendees = next.guests.map { guest in
        let existing = answered[guest.email.lowercased()]
        return Attendee(
          email: guest.email,
          displayName: guest.displayName ?? existing?.displayName,
          responseStatus: existing?.responseStatus,
          optional: existing?.optional
        )
      }
    }
  }

  private init() {}

  private static func reminderSet(_ reminders: [Double]?) -> Set<Double>? {
    reminders.map(Set.init)
  }
}

/// How far an edit or delete of a repeating event reaches.
nonisolated enum EditScope: String, CaseIterable, Sendable {
  case thisEvent, thisAndFollowing, allEvents

  var label: String {
    switch self {
    case .thisEvent: "This event"
    case .thisAndFollowing: "This and following events"
    case .allEvents: "All events"
    }
  }
}

// MARK: - Reminders

/// The web's reminder presets and labels (reminders.ts).
nonisolated enum ReminderPresets {
  /// Offsets before a timed event's start.
  static let timed: [Double] = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10_080]

  /// All-day offsets count back from local midnight of the first day: the
  /// day before at 9:00 and 18:00, two days before and a week before at 9:00.
  static let allDay: [Double] = [
    allDayMinutes(days: 1, at: 9 * 60),
    allDayMinutes(days: 1, at: 18 * 60),
    allDayMinutes(days: 2, at: 9 * 60),
    allDayMinutes(days: 7, at: 9 * 60),
  ]

  static func presets(allDay: Bool) -> [Double] { allDay ? Self.allDay : timed }

  private static func allDayMinutes(days: Double, at timeOfDay: Double) -> Double {
    max(0, days * 1440 - timeOfDay)
  }

  /// "10 min before", "1 hour before", "The day before at 9:00 AM".
  static func label(_ minutes: Double, allDay: Bool, use24h: Bool) -> String {
    let minutes = Int(minutes)
    if allDay {
      let days = Int((Double(minutes) / 1440).rounded(.up))
      let timeOfDay = days * 1440 - minutes
      let dayText =
        switch days {
        case ...0: "On the day"
        case 1: "The day before"
        case 7: "A week before"
        default: "\(days) days before"
        }
      return "\(dayText) at \(formatWallClockMinutes(Double(timeOfDay), use24h: use24h))"
    }
    func plural(_ n: Int, _ unit: String) -> String { "\(n) \(unit)\(n == 1 ? "" : "s") before" }
    if minutes == 0 { return "At time of event" }
    if minutes % 10_080 == 0 { return plural(minutes / 10_080, "week") }
    if minutes % 1440 == 0 { return plural(minutes / 1440, "day") }
    if minutes % 60 == 0 { return plural(minutes / 60, "hour") }
    return "\(minutes) min before"
  }

  /// What the picker reads: "Default · 10 min before", "None", one label or
  /// a count.
  static func summary(_ reminders: [Double]?, allDay: Bool, use24h: Bool, defaults: [Double]?) -> String {
    guard let reminders else {
      guard let defaults, let first = defaults.first else { return "Default" }
      let text = label(first, allDay: allDay, use24h: use24h)
      return defaults.count == 1 ? "Default · \(text)" : "Default · \(text) +\(defaults.count - 1)"
    }
    switch reminders.count {
    case 0: return "None"
    case 1: return label(reminders[0], allDay: allDay, use24h: use24h)
    default: return "\(reminders.count) reminders"
    }
  }
}
