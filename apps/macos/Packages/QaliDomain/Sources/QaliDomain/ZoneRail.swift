import Foundation

// The time rail's other zones: extra columns of hour labels beside the
// working zone's, read off the working zone's hour lines. The calendar still
// runs in one zone (see `WorkingZone`); these only relabel its hours.

/// How a column of another zone's hours reads against the working zone's
/// grid on one day. Positions are hours since the working zone's midnight,
/// the same measure the grid draws its lines and the now marker by.
public struct ZoneRailColumn: Equatable, Sendable {
  public struct Label: Equatable, Sendable {
    /// The working zone's hour line it sits on, 1…23.
    public let line: Int
    public let text: String
  }

  /// Where a new day starts in the other zone, and how many days its date
  /// then runs ahead of (+) or behind (−) the working zone's.
  public struct DayStart: Equatable, Sendable {
    public let hours: Double
    public let dayOffset: Int
  }

  /// Where morning (sunrise) or evening starts in the other zone.
  public struct DaylightEdge: Equatable, Sendable {
    public let hours: Double
    public let rises: Bool
  }

  public let labels: [Label]
  public let dayStarts: [DayStart]
  public let daylightEdges: [DaylightEdge]
}

/// The rail column for `other` on `day` (a working-zone midnight).
public func zoneRailColumn(
  day: Date,
  primary: WorkingZone,
  other: WorkingZone,
  use24h: Bool,
  daylight: (rise: Int, set: Int) = (6, 18)
) -> ZoneRailColumn {
  let start = primary.startOfDay(day)
  let hours = { (date: Date) in date.timeIntervalSince(start) / 3600 }

  let labels = (1..<24).map { line in
    ZoneRailColumn.Label(line: line, text: railHourLabel(start.addingTimeInterval(Double(line) * 3600), in: other, use24h: use24h))
  }

  // The other zone's midnights from the one before this day began onwards;
  // two more cover any offset.
  let firstMidnight = other.startOfDay(start)
  let dayStarts = (0...2).compactMap { step -> ZoneRailColumn.DayStart? in
    let midnight = other.addingDays(step, to: firstMidnight)
    let at = hours(midnight)
    guard at > 0, at < 24 else { return nil }
    return .init(hours: at, dayOffset: calendarDayOffset(midnight, of: other, from: primary))
  }

  // The other zone's 6am and 6pm on its days around this one, kept where
  // they fall inside the working zone's day.
  let daylightEdges = (-1...1).flatMap { step -> [ZoneRailColumn.DaylightEdge] in
    let otherDay = other.addingDays(step, to: firstMidnight)
    return [(daylight.rise, true), (daylight.set, false)].compactMap { hour, rises in
      guard let at = other.calendar.date(bySettingHour: hour, minute: 0, second: 0, of: otherDay) else { return nil }
      let position = hours(at)
      return position > 0 && position < 24 ? .init(hours: position, rises: rises) : nil
    }
  }
  .sorted { $0.hours < $1.hours }

  return ZoneRailColumn(labels: labels, dayStarts: dayStarts, daylightEdges: daylightEdges)
}

/// An hour line's label in another zone: "5pm" / "17", or "5:30pm" / "17:30"
/// where the zone sits off the hour.
public func railHourLabel(_ date: Date, in zone: WorkingZone, use24h: Bool) -> String {
  let parts = zone.calendar.dateComponents([.hour, .minute], from: date)
  let hour = parts.hour ?? 0, minute = parts.minute ?? 0
  let minutes = minute == 0 ? "" : ":\(minute < 10 ? "0" : "")\(minute)"
  if use24h { return "\(hour)\(minutes)" }
  return "\(hour % 12 == 0 ? 12 : hour % 12)\(minutes)\(hour < 12 ? "am" : "pm")"
}

/// How far `other`'s clock runs from the working zone's at `date`: "+5h",
/// "−3h", "+5:30", or "±0h".
public func zoneOffsetLabel(_ other: WorkingZone, from primary: WorkingZone, at date: Date) -> String {
  let seconds = other.timeZone.secondsFromGMT(for: date) - primary.timeZone.secondsFromGMT(for: date)
  if seconds == 0 { return "±0h" }
  let sign = seconds < 0 ? "−" : "+"
  let hours = abs(seconds) / 3600, minutes = abs(seconds) % 3600 / 60
  return minutes == 0 ? "\(sign)\(hours)h" : "\(sign)\(hours):\(minutes < 10 ? "0" : "")\(minutes)"
}

/// Days between the calendar date `date` falls on in `other` and in
/// `primary`.
public func calendarDayOffset(_ date: Date, of other: WorkingZone, from primary: WorkingZone) -> Int {
  var utc = Calendar(identifier: .gregorian)
  utc.timeZone = TimeZone(identifier: "UTC")!
  let parts = { (zone: WorkingZone) in
    utc.date(from: zone.calendar.dateComponents([.year, .month, .day], from: date))!
  }
  return utc.dateComponents([.day], from: parts(primary), to: parts(other)).day ?? 0
}

/// A zone's three-letter rail label: a well-known city code for common zones
/// ("NYC", "LDN", "TYO"), else letters from its city ("Kathmandu" → "KAT",
/// "Port Moresby" → "PMO").
public func zoneCode(_ identifier: String) -> String {
  if let known = knownZoneCodes[identifier] { return known }
  let city = zoneShortLabel(identifier)
    .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
  let words = city
    .split { !$0.isLetter }
    .map(String.init)
  guard let last = words.last else { return String(identifier.prefix(3)).uppercased() }
  var code = words.count > 1 ? words.compactMap(\.first).map(String.init).joined() : ""
  if code.count < 3 {
    // Fill from the last word, after the letter the initials already took.
    let rest = words.count > 1 ? last.dropFirst() : Substring(last)
    code += rest.prefix(3 - code.count)
  }
  return String(code.prefix(3)).uppercased()
}

private let knownZoneCodes: [String: String] = [
  "America/New_York": "NYC", "America/Los_Angeles": "LAX", "America/Chicago": "CHI",
  "America/Denver": "DEN", "America/Phoenix": "PHX", "America/Anchorage": "ANC",
  "Pacific/Honolulu": "HNL", "America/Toronto": "TOR", "America/Vancouver": "VAN",
  "America/Halifax": "HFX", "America/Mexico_City": "MEX", "America/Bogota": "BOG",
  "America/Lima": "LIM", "America/Santiago": "SCL", "America/Sao_Paulo": "SAO",
  "America/Argentina/Buenos_Aires": "BUE", "America/Buenos_Aires": "BUE",
  "Europe/London": "LDN", "Europe/Dublin": "DUB", "Europe/Lisbon": "LIS",
  "Europe/Paris": "PAR", "Europe/Berlin": "BER", "Europe/Madrid": "MAD", "Europe/Rome": "ROM",
  "Europe/Amsterdam": "AMS", "Europe/Brussels": "BRU", "Europe/Zurich": "ZRH",
  "Europe/Vienna": "VIE", "Europe/Prague": "PRG", "Europe/Warsaw": "WAW",
  "Europe/Stockholm": "STO", "Europe/Oslo": "OSL", "Europe/Copenhagen": "CPH",
  "Europe/Helsinki": "HEL", "Europe/Athens": "ATH", "Europe/Istanbul": "IST",
  "Europe/Kyiv": "KYV", "Europe/Kiev": "KYV", "Europe/Moscow": "MOW",
  "Africa/Casablanca": "CAS", "Africa/Lagos": "LOS", "Africa/Cairo": "CAI",
  "Africa/Johannesburg": "JNB", "Africa/Nairobi": "NBO", "Africa/Addis_Ababa": "ADD",
  "Asia/Dubai": "DXB", "Asia/Riyadh": "RUH", "Asia/Tehran": "THR", "Asia/Karachi": "KHI",
  "Asia/Kolkata": "IND", "Asia/Calcutta": "IND", "Asia/Dhaka": "DAC",
  "Asia/Bangkok": "BKK", "Asia/Jakarta": "JKT", "Asia/Singapore": "SIN",
  "Asia/Kuala_Lumpur": "KUL", "Asia/Manila": "MNL", "Asia/Hong_Kong": "HKG",
  "Asia/Shanghai": "SHA", "Asia/Taipei": "TPE", "Asia/Seoul": "SEL", "Asia/Tokyo": "TYO",
  "Australia/Perth": "PER", "Australia/Adelaide": "ADL", "Australia/Brisbane": "BNE",
  "Australia/Sydney": "SYD", "Australia/Melbourne": "MEL", "Pacific/Auckland": "AKL",
  "UTC": "UTC", "Etc/UTC": "UTC", "GMT": "GMT", "Etc/GMT": "GMT",
]

/// A timed event's span read in one of the rail's other zones, for the
/// event detail: "11:30 PM – 12:30 AM", with the day or days when they are
/// not the event's own, and whether it starts in that zone's daytime.
public struct ZoneEventTime: Equatable, Sendable {
  public let identifier: String
  public let code: String
  public let time: String
  /// "Wed" when it starts on another date there than here; "Tue → Wed" when
  /// it runs past midnight there; nil when it is the same day.
  public let days: String?
  /// Starts between 6am and 6pm in that zone.
  public let isDaytime: Bool
}

public func eventTimesInZones(
  startMs: Double,
  endMs: Double,
  zones: [WorkingZone],
  primary: WorkingZone,
  use24h: Bool
) -> [ZoneEventTime] {
  let start = Date(ms: startMs), end = Date(ms: endMs)
  let pattern = timePattern(use24h: use24h)
  return zones.map { zone in
    // The last instant inside the event decides its last day, so an event
    // ending exactly at midnight stays on the day it ran.
    let lastInstant = end > start ? end.addingTimeInterval(-1) : end
    let crosses = !zone.isSameDay(start, lastInstant)
    let moved = calendarDayOffset(start, of: zone, from: primary) != 0
    let days: String? =
      crosses
      ? "\(zone.format(start, "EEE")) → \(zone.format(lastInstant, "EEE"))"
      : moved ? zone.format(start, "EEE") : nil
    let hour = zone.calendar.component(.hour, from: start)
    return ZoneEventTime(
      identifier: zone.identifier,
      code: zoneCode(zone.identifier),
      time: "\(zone.format(start, pattern)) – \(zone.format(end, pattern))",
      days: days,
      isDaytime: (6..<18).contains(hour)
    )
  }
}
