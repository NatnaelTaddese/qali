import Foundation

// Port of packages/domain/src/calendar/zone.ts.
//
// The calendar operates in ONE zone — the user's timezone preference, falling
// back to the device's — for day cuts, labels and the zone stamped on writes.
// TypeScript carries the zone inside each TZDate; here every calendar
// operation goes through a `WorkingZone`, so a `Date` is only ever an instant.

/// The working time zone and the Gregorian calendar cut in it.
public struct WorkingZone: Sendable, Hashable {
  public let timeZone: TimeZone
  public let calendar: Calendar

  public init(_ timeZone: TimeZone) {
    self.timeZone = timeZone
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    calendar.locale = Locale(identifier: "en_US_POSIX")
    self.calendar = calendar
  }

  /// A zone by IANA identifier; nil when the identifier is unknown.
  public init?(identifier: String) {
    guard let timeZone = TimeZone(identifier: identifier) else { return nil }
    self.init(timeZone)
  }

  /// The user's preferred zone when it is set and valid, else the device's.
  public static func resolve(preference: String?) -> WorkingZone {
    preference.flatMap(WorkingZone.init(identifier:)) ?? WorkingZone(.current)
  }

  public var identifier: String { timeZone.identifier }

  // MARK: date-fns equivalents, evaluated in this zone

  public func startOfDay(_ date: Date) -> Date {
    calendar.startOfDay(for: date)
  }

  /// `addDays`: keeps the wall-clock time across DST changes.
  public func addingDays(_ days: Int, to date: Date) -> Date {
    calendar.date(byAdding: .day, value: days, to: date)!
  }

  public func addingWeeks(_ weeks: Int, to date: Date) -> Date {
    addingDays(weeks * 7, to: date)
  }

  /// `addMonths`: clamps the day to the target month's length.
  public func addingMonths(_ months: Int, to date: Date) -> Date {
    calendar.date(byAdding: .month, value: months, to: date)!
  }

  public func startOfWeek(_ date: Date, weekStartsOn: WeekStart) -> Date {
    let day = startOfDay(date)
    // Foundation weekdays are 1 (Sunday) … 7; date-fns uses 0 (Sunday) … 6.
    let weekday = calendar.component(.weekday, from: day) - 1
    let diff = (weekday + 7 - weekStartsOn.rawValue) % 7
    return addingDays(-diff, to: day)
  }

  public func startOfMonth(_ date: Date) -> Date {
    calendar.date(from: calendar.dateComponents([.year, .month], from: date))!
  }

  public func isSameDay(_ a: Date, _ b: Date) -> Bool {
    calendar.isDate(a, inSameDayAs: b)
  }

  public func isSameMonth(_ a: Date, _ b: Date) -> Bool {
    calendar.isDate(a, equalTo: b, toGranularity: .month)
  }

  public func isSameYear(_ a: Date, _ b: Date) -> Bool {
    calendar.isDate(a, equalTo: b, toGranularity: .year)
  }

  /// Formats with a Unicode (ICU) pattern in this zone. The patterns used here
  /// ("HH:mm", "h:mm a", "EEE d MMM", "MMMM yyyy", …) mean the same in ICU as
  /// in date-fns, and the POSIX locale matches date-fns' default en-US output.
  public func format(_ date: Date, _ pattern: String) -> String {
    DateFormatterCache.shared.formatter(timeZone: timeZone, pattern: pattern).string(from: date)
  }

  /// The instant at `hour` on the given calendar date in this zone.
  func date(year: Int, month: Int, day: Int, hour: Int = 0) -> Date {
    calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
  }
}

/// A working-zone instant on the calendar date of an all-day boundary (which
/// Google stores as UTC midnight), so day labels show the day Google meant.
/// Noon, so no DST shift can tip it into a neighbouring day.
public func fromUtcMidnight(_ ms: Double, zone: WorkingZone) -> Double {
  var utc = Calendar(identifier: .gregorian)
  utc.timeZone = TimeZone(identifier: "UTC")!
  let parts = utc.dateComponents([.year, .month, .day], from: Date(ms: ms))
  return zone.date(year: parts.year!, month: parts.month!, day: parts.day!, hour: 12).ms
}

/// Time pattern for the user's clock preference. `withDayPeriod` only matters
/// for 12-hour clocks — 24-hour time has no AM/PM to show.
public func timePattern(use24h: Bool, withDayPeriod: Bool = true) -> String {
  if use24h { return "HH:mm" }
  return withDayPeriod ? "h:mm a" : "h:mm"
}

/// The zone-correct bounds of an event for display. All-day bounds are UTC
/// midnights (endMs exclusive) read back through `fromUtcMidnight` so the
/// working zone can't shift the day; timed bounds are the instants themselves,
/// with `endText` spelling out the day when the end crosses one.
public enum EventTimeParts: Equatable, Sendable {
  case allDay(start: Date, lastDay: Date)
  case timed(start: Date, end: Date, timePattern: String, endText: String)
}

public func eventTimeParts(
  _ event: some CalendarEventLike,
  use24h: Bool,
  zone: WorkingZone
) -> EventTimeParts {
  if event.allDay {
    return .allDay(
      start: Date(ms: fromUtcMidnight(event.startMs, zone: zone)),
      lastDay: Date(ms: fromUtcMidnight(event.endMs - msPerDay, zone: zone))
    )
  }
  let start = Date(ms: event.startMs)
  let end = Date(ms: event.endMs)
  let time = timePattern(use24h: use24h)
  let endText = zone.format(end, zone.isSameDay(start, end) ? time : "EEE d MMM, \(time)")
  return .timed(start: start, end: end, timePattern: time, endText: endText)
}

/// Format minutes from midnight without interpreting them as an instant.
public func formatWallClockMinutes(
  _ minutes: Double,
  includeDayPeriod: Bool = true,
  use24h: Bool = false
) -> String {
  let day = 24 * 60
  // JavaScript's Math.round rounds halves up (toward +∞).
  let rounded = Int((minutes + 0.5).rounded(.down))
  let normalized = ((rounded % day) + day) % day
  let hour24 = normalized / 60
  let minute = normalized % 60
  let paddedMinute = minute < 10 ? "0\(minute)" : "\(minute)"
  if use24h {
    return "\(hour24 < 10 ? "0\(hour24)" : "\(hour24)"):\(paddedMinute)"
  }
  let hour12 = hour24 % 12 == 0 ? 12 : hour24 % 12
  let time = "\(hour12):\(paddedMinute)"
  guard includeDayPeriod else { return time }
  return "\(time) \(hour24 < 12 ? "AM" : "PM")"
}

/// A zone's short human label, e.g. "New York" from "America/New_York".
public func zoneShortLabel(_ zone: String) -> String {
  (zone.split(separator: "/").last.map(String.init) ?? zone)
    .replacingOccurrences(of: "_", with: " ")
}

/// Stable reveal key for a whole day, keyed by its working-zone midnight.
public func dayKey(_ date: Date, zone: WorkingZone) -> String {
  "day:\(Int64(zone.startOfDay(date).ms))"
}

/// Formatters by zone and pattern. Making a `DateFormatter` is expensive and
/// the calendar formats every visible day on each redraw; formatting with a
/// configured one is thread-safe.
final class DateFormatterCache: @unchecked Sendable {
  static let shared = DateFormatterCache()

  private let lock = NSLock()
  private var formatters: [String: DateFormatter] = [:]

  func formatter(timeZone: TimeZone, pattern: String) -> DateFormatter {
    let key = timeZone.identifier + "|" + pattern
    lock.lock()
    defer { lock.unlock() }
    if let formatter = formatters[key] { return formatter }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = timeZone
    formatter.dateFormat = pattern
    formatters[key] = formatter
    return formatter
  }
}
