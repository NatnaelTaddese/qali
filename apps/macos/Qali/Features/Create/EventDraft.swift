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
  var repeatRule: RepeatRule?
  /// Popup offsets in minutes. Nil is the calendar's default; empty is none.
  var reminders: [Double]?

  init(startMs: Double, endMs: Double) {
    self.startMs = startMs
    self.endMs = endMs
  }

  var isValid: Bool { endMs > startMs }

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

/// Someone invited to the new event. The photo is only for the chip.
nonisolated struct DraftGuest: Hashable, Sendable {
  var email: String
  var displayName: String?
  var photoUrl: String?
}

// MARK: - Repeat

/// The web Repeat control's presets (repeat-control.tsx), each one RRULE.
nonisolated enum RepeatRule: Hashable, Sendable, CaseIterable {
  case daily, weekly, weekdays, monthly, yearly

  func label(startMs: Double, zone: WorkingZone) -> String {
    switch self {
    case .daily: "Daily"
    case .weekly: "Weekly on \(zone.format(Date(ms: startMs), "EEEE"))"
    case .weekdays: "Every weekday"
    case .monthly: "Monthly"
    case .yearly: "Annually"
    }
  }

  /// Google's `recurrence` lines (the web's `toRRule`). A weekly rule repeats
  /// on the start's weekday in the working zone.
  func rrule(startMs: Double, zone: WorkingZone) -> [String] {
    switch self {
    case .daily: ["RRULE:FREQ=DAILY"]
    case .weekly: ["RRULE:FREQ=WEEKLY;BYDAY=\(Self.weekday(startMs, zone: zone))"]
    case .weekdays: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]
    case .monthly: ["RRULE:FREQ=MONTHLY"]
    case .yearly: ["RRULE:FREQ=YEARLY"]
    }
  }

  private static func weekday(_ ms: Double, zone: WorkingZone) -> String {
    // Calendar weekdays count from Sunday = 1.
    let codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
    return codes[zone.calendar.component(.weekday, from: Date(ms: ms)) - 1]
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
