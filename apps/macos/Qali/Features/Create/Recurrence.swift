import Foundation
import QaliDomain

/// A repeat rule as the form edits it (the web's `rrule.ts`): how often, every
/// how many, on which weekdays, and until when. Only the subset the app can
/// create is modelled; `parse` reads that subset back from Google's lines.
nonisolated struct Recurrence: Hashable, Sendable {
  enum Freq: String, CaseIterable, Sendable {
    case daily = "DAILY", weekly = "WEEKLY", monthly = "MONTHLY", yearly = "YEARLY"

    /// "day", "week"… for "Every 2 weeks".
    var noun: String {
      switch self {
      case .daily: "day"
      case .weekly: "week"
      case .monthly: "month"
      case .yearly: "year"
      }
    }

    var adverb: String {
      switch self {
      case .daily: "Daily"
      case .weekly: "Weekly"
      case .monthly: "Monthly"
      case .yearly: "Annually"
      }
    }
  }

  /// RRULE weekday codes, Monday first.
  enum Weekday: String, CaseIterable, Sendable {
    case mo = "MO", tu = "TU", we = "WE", th = "TH", fr = "FR", sa = "SA", su = "SU"

    /// Calendar's weekday number: Sunday = 1.
    var calendarWeekday: Int {
      switch self {
      case .su: 1
      case .mo: 2
      case .tu: 3
      case .we: 4
      case .th: 5
      case .fr: 6
      case .sa: 7
      }
    }

    init(calendarWeekday: Int) {
      self = Self.allCases.first { $0.calendarWeekday == calendarWeekday } ?? .mo
    }

    /// "Mon", "Tue"…
    var short: String { Self.shortNames[self]! }
    private static let shortNames: [Weekday: String] = [
      .mo: "Mon", .tu: "Tue", .we: "Wed", .th: "Thu", .fr: "Fri", .sa: "Sat", .su: "Sun",
    ]

    /// The day's initial, for the weekday toggles.
    var initial: String { String(Self.shortNames[self]!.prefix(1)) }

    /// The working-zone weekday of an instant.
    static func of(_ ms: Double, zone: WorkingZone) -> Weekday {
      Weekday(calendarWeekday: zone.calendar.component(.weekday, from: Date(ms: ms)))
    }

    static let workdays: Set<Weekday> = [.mo, .tu, .we, .th, .fr]

    /// The week in the user's order, from their first day.
    static func ordered(from start: WeekStart) -> [Weekday] {
      let first = Weekday(calendarWeekday: start.rawValue + 1)
      let index = allCases.firstIndex(of: first) ?? 0
      return Array(allCases[index...] + allCases[..<index])
    }
  }

  enum End: Hashable, Sendable {
    case never
    /// Up to and including this working-zone day (its midnight, in ms).
    case onDate(Double)
    case count(Int)
  }

  var freq: Freq
  /// "Every N", at least 1.
  var interval = 1
  /// Weekly only: the days it repeats on. Never empty for a weekly rule.
  var byWeekday: Set<Weekday> = []
  var end: End = .never

  init(freq: Freq, interval: Int = 1, byWeekday: Set<Weekday> = [], end: End = .never) {
    self.freq = freq
    self.interval = interval
    self.byWeekday = byWeekday
    self.end = end
  }

  // MARK: Presets

  static func daily() -> Recurrence { Recurrence(freq: .daily) }
  static func weekly(on day: Weekday) -> Recurrence { Recurrence(freq: .weekly, byWeekday: [day]) }
  static func everyWeekday() -> Recurrence { Recurrence(freq: .weekly, byWeekday: Weekday.workdays) }
  static func monthly() -> Recurrence { Recurrence(freq: .monthly) }
  static func yearly() -> Recurrence { Recurrence(freq: .yearly) }

  // MARK: Editing

  /// A frequency change keeps the interval and end; a weekly rule needs a
  /// day, so it starts on the event's own.
  func with(freq: Freq, startMs: Double, zone: WorkingZone) -> Recurrence {
    var next = self
    next.freq = freq
    if freq == .weekly {
      if next.byWeekday.isEmpty { next.byWeekday = [Weekday.of(startMs, zone: zone)] }
    } else {
      next.byWeekday = []
    }
    return next
  }

  /// Toggles a weekday, never leaving the rule with none.
  func toggling(_ day: Weekday) -> Recurrence {
    var next = self
    if next.byWeekday.contains(day) {
      if next.byWeekday.count > 1 { next.byWeekday.remove(day) }
    } else {
      next.byWeekday.insert(day)
    }
    return next
  }

  // MARK: RRULE

  /// Google's `recurrence` lines (the web's `toRRule`). An end date is stamped
  /// as the end of that working-zone day in UTC, Google's own convention, so
  /// every occurrence on it counts and `parse` reads the same day back.
  func rrule(zone: WorkingZone) -> [String] {
    var parts = ["FREQ=\(freq.rawValue)"]
    if interval > 1 { parts.append("INTERVAL=\(interval)") }
    if freq == .weekly, !byWeekday.isEmpty {
      parts.append("BYDAY=" + Weekday.allCases.filter(byWeekday.contains).map(\.rawValue).joined(separator: ","))
    }
    switch end {
    case .never:
      break
    case .count(let count):
      parts.append("COUNT=\(max(1, count))")
    case .onDate(let dayMs):
      let day = zone.startOfDay(Date(ms: dayMs))
      let last = zone.addingDays(1, to: day).addingTimeInterval(-1)
      var utc = Calendar(identifier: .gregorian)
      utc.timeZone = .gmt
      let c = utc.dateComponents([.year, .month, .day, .hour, .minute, .second], from: last)
      let stamp = String(
        format: "%04d%02d%02dT%02d%02d%02dZ",
        c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0, c.second ?? 0
      )
      parts.append("UNTIL=\(stamp)")
    }
    return ["RRULE:" + parts.joined(separator: ";")]
  }

  /// Reads the subset of an RRULE this model can hold; nil for anything else.
  /// Other lines (EXDATE…) are ignored.
  static func parse(_ lines: [String], zone: WorkingZone) -> Recurrence? {
    guard let line = lines.first(where: { $0.hasPrefix("RRULE:") }) else { return nil }
    var fields: [String: String] = [:]
    for part in line.dropFirst("RRULE:".count).split(separator: ";", omittingEmptySubsequences: false) {
      let pieces = part.split(separator: "=", maxSplits: 1).map(String.init)
      guard pieces.count == 2, !pieces[1].isEmpty, fields[pieces[0]] == nil else { return nil }
      fields[pieces[0]] = pieces[1]
    }
    let supported: Set = ["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"]
    guard fields.keys.allSatisfy(supported.contains), let freq = fields["FREQ"].flatMap(Freq.init(rawValue:))
    else { return nil }
    var rule = Recurrence(freq: freq)

    if let text = fields["INTERVAL"] {
      guard let value = positive(text) else { return nil }
      rule.interval = value
    }
    if let text = fields["BYDAY"] {
      let days = text.split(separator: ",").map { Weekday(rawValue: String($0)) }
      guard freq == .weekly, !days.isEmpty, days.allSatisfy({ $0 != nil }) else { return nil }
      rule.byWeekday = Set(days.compactMap { $0 })
    }
    switch (fields["COUNT"], fields["UNTIL"]) {
    case (.some, .some):
      return nil
    case (.some(let text), nil):
      guard let count = positive(text) else { return nil }
      rule.end = .count(count)
    case (nil, .some(let text)):
      guard let day = untilDay(text, zone: zone) else { return nil }
      rule.end = .onDate(day)
    case (nil, nil):
      break
    }
    return rule
  }

  // MARK: Words

  /// "Weekly on Mon, Wed · 5 times" (the web's `summarize`), with "Every
  /// weekday" for Monday to Friday.
  func summary(zone: WorkingZone) -> String {
    var text: String
    if freq == .weekly, interval == 1, byWeekday == Weekday.workdays {
      text = "Every weekday"
    } else {
      text = interval > 1 ? "Every \(interval) \(freq.noun)s" : freq.adverb
      if freq == .weekly, !byWeekday.isEmpty {
        text += " on " + Weekday.allCases.filter(byWeekday.contains).map(\.short).joined(separator: ", ")
      }
    }
    switch end {
    case .never: break
    case .count(let count): text += " · \(count) time\(count == 1 ? "" : "s")"
    case .onDate(let day): text += " · until \(zone.format(Date(ms: day), "MMM d, yyyy"))"
    }
    return text
  }

  private static func positive(_ text: String) -> Int? {
    guard text.range(of: "^[1-9][0-9]{0,8}$", options: .regularExpression) != nil else { return nil }
    return Int(text)
  }

  /// UNTIL is a calendar date, or a UTC instant read on the working zone's
  /// calendar (Google normalises "ends Aug 26" in New York to
  /// 20260827T035959Z). Returns that day's working-zone midnight.
  private static func untilDay(_ value: String, zone: WorkingZone) -> Double? {
    guard let match = value.wholeMatch(of: #/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?/#) else { return nil }
    let year = Int(match.1)!, month = Int(match.2)!, day = Int(match.3)!
    if match.4 != nil {
      var utc = Calendar(identifier: .gregorian)
      utc.timeZone = .gmt
      let parts = DateComponents(
        year: year, month: month, day: day,
        hour: Int(match.4!)!, minute: Int(match.5!)!, second: Int(match.6!)!
      )
      guard let instant = utc.date(from: parts), utc.component(.day, from: instant) == day else { return nil }
      return zone.startOfDay(instant).ms
    }
    let parts = DateComponents(year: year, month: month, day: day)
    guard let date = zone.calendar.date(from: parts), zone.calendar.component(.day, from: date) == day else { return nil }
    return zone.startOfDay(date).ms
  }
}
