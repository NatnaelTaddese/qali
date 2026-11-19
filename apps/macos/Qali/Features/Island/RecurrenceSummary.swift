import Foundation
import QaliDomain

/// "Weekly on Mon, Wed · 5 times": a repeating event's rule in words (the
/// web's `parseRRule` + `summarize`). Only the subset the app can describe is
/// read; anything else gives nil, and the detail says "Part of a repeating
/// series" instead.
nonisolated enum RecurrenceSummary {
  private static let weekdays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
  private static let weekdayLabels = ["MO": "Mon", "TU": "Tue", "WE": "Wed", "TH": "Thu", "FR": "Fri", "SA": "Sat", "SU": "Sun"]
  private static let nouns = ["DAILY": "day", "WEEKLY": "week", "MONTHLY": "month", "YEARLY": "year"]
  private static let adverbs = ["DAILY": "Daily", "WEEKLY": "Weekly", "MONTHLY": "Monthly", "YEARLY": "Annually"]

  static func summarize(_ lines: [String], zone: WorkingZone) -> String? {
    guard let line = lines.first(where: { $0.hasPrefix("RRULE:") }) else { return nil }
    var fields: [String: String] = [:]
    for part in line.dropFirst("RRULE:".count).split(separator: ";", omittingEmptySubsequences: false) {
      let pieces = part.split(separator: "=", maxSplits: 1).map(String.init)
      guard pieces.count == 2, !pieces[1].isEmpty, fields[pieces[0]] == nil else { return nil }
      fields[pieces[0]] = pieces[1]
    }
    let supported: Set = ["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"]
    guard fields.keys.allSatisfy(supported.contains),
      let freq = fields["FREQ"], let noun = nouns[freq], let adverb = adverbs[freq]
    else { return nil }

    var interval = 1
    if let text = fields["INTERVAL"] {
      guard let value = positive(text) else { return nil }
      interval = value
    }
    var text = interval > 1 ? "Every \(interval) \(noun)s" : adverb

    if let byDay = fields["BYDAY"] {
      let days = byDay.split(separator: ",").map(String.init)
      guard freq == "WEEKLY", !days.isEmpty, days.allSatisfy(weekdays.contains) else { return nil }
      text += " on " + weekdays.filter(days.contains).compactMap { weekdayLabels[$0] }.joined(separator: ", ")
    }

    switch (fields["COUNT"], fields["UNTIL"]) {
    case (.some, .some):
      return nil
    case (.some(let count), nil):
      guard let count = positive(count) else { return nil }
      text += " · \(count) time\(count == 1 ? "" : "s")"
    case (nil, .some(let until)):
      guard let day = untilDay(until, zone: zone) else { return nil }
      text += " · until \(day)"
    case (nil, nil):
      break
    }
    return text
  }

  private static func positive(_ text: String) -> Int? {
    guard text.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil else { return nil }
    return Int(text)
  }

  /// UNTIL is a calendar date, or a UTC instant read on the working zone's
  /// calendar (Google normalises "ends Aug 26" in New York to 20260827T035959Z).
  private static func untilDay(_ value: String, zone: WorkingZone) -> String? {
    guard let match = value.wholeMatch(of: #/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?/#) else { return nil }
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = .gmt
    let components = DateComponents(
      year: Int(match.1), month: Int(match.2), day: Int(match.3),
      hour: match.4.flatMap { Int($0) } ?? 12, minute: match.5.flatMap { Int($0) } ?? 0, second: match.6.flatMap { Int($0) } ?? 0
    )
    guard let date = utc.date(from: components) else { return nil }
    if match.4 != nil { return zone.format(date, "MMM d, yyyy") }
    // A bare date is already a calendar day: read it at noon UTC, which no
    // zone moves to another day.
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .gmt
    formatter.dateFormat = "MMM d, yyyy"
    return formatter.string(from: date)
  }
}
