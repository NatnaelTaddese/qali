import Foundation
import QaliDomain

/// The menu bar companion's settings, stored per Mac in UserDefaults. Views
/// read them with `@AppStorage(MenuBarPrefs.x)`; the defaults are registered
/// at launch so every reader agrees on them.
enum MenuBarPrefs {
  static let enabled = "menuBar.enabled"
  static let style = "menuBar.style"
  static let showTitles = "menuBar.showTitles"
  /// Minutes ahead the next event is shown in the menu bar; 0 = the rest of
  /// today.
  static let lookahead = "menuBar.lookahead"
  static let joinPill = "menuBar.joinPill"
  static let includeTomorrow = "menuBar.includeTomorrow"
  /// A clock per zone (yours and the time rail's) under the panel's date.
  static let worldClock = "menuBar.worldClock"
  /// Whether the panel's clock has a tile for your own zone.
  static let clockIncludesYours = "menuBar.clockIncludesYours"
  /// The "Today · +1h" line under each clock.
  static let clockDetails = "menuBar.clockDetails"
  /// The sun or moon on each clock, in the panel and the menu bar item.
  static let clockIcons = "menuBar.clockIcons"
  /// The zone the World clock menu bar item shows; empty or gone = the
  /// first of the time rail's zones.
  static let clockZone = "menuBar.clockZone"
  static let hideDockIcon = "menuBar.hideDockIcon"

  static func registerDefaults() {
    UserDefaults.standard.register(defaults: [
      enabled: true,
      style: MenuBarStyle.nextUp.rawValue,
      showTitles: true,
      lookahead: 180,
      joinPill: true,
      includeTomorrow: true,
      worldClock: true,
      clockIncludesYours: true,
      clockDetails: true,
      clockIcons: true,
      clockZone: "",
      hideDockIcon: false,
    ])
  }

  static var isEnabled: Bool { UserDefaults.standard.bool(forKey: enabled) }

  /// The World clock item's zone: the one picked if it is still on the rail,
  /// else the rail's first; nil with no rail zones.
  static func clockZone(_ picked: String, rail: String) -> WorkingZone? {
    let others = ZoneRailPrefs.zones(rail)
    return others.first { $0.identifier == picked } ?? others.first
  }
  static var hidesDockIcon: Bool { UserDefaults.standard.bool(forKey: hideDockIcon) }
}

/// What the status item shows.
enum MenuBarStyle: String, CaseIterable, Identifiable {
  /// The next event's title and countdown; today's date when nothing is near.
  case nextUp
  /// Today's day number, in the app's serif.
  case date
  /// One of the time rail's zones and its time ("TYO 9:08 PM").
  case worldClock
  /// The calendar glyph alone.
  case icon

  var id: Self { self }

  var label: String {
    switch self {
    case .nextUp: "Next event"
    case .date: "Date"
    case .worldClock: "World clock"
    case .icon: "Icon only"
    }
  }
}

/// Which events the companion counts: not cancelled and not declined.
func countsForAgenda(_ event: CalendarEvent) -> Bool {
  if event.status == "cancelled" { return false }
  if event.attendees?.first(where: { $0.isSelf == true })?.responseStatus == "declined" { return false }
  return true
}

/// The events overlapping one working-zone day, all-day ones first, then by
/// start. All-day bounds are UTC midnights, read back into the zone.
func agendaDay(_ events: [CalendarEvent], dayStart: Date, zone: WorkingZone) -> (allDay: [CalendarEvent], timed: [CalendarEvent]) {
  let startMs = dayStart.ms
  let endMs = zone.addingDays(1, to: dayStart).ms
  let counted = events.filter(countsForAgenda)
  let allDay = counted.filter {
    $0.allDay && fromUtcMidnight($0.startMs, zone: zone) < endMs && fromUtcMidnight($0.endMs, zone: zone) > startMs
  }
  let timed = counted
    .filter { !$0.allDay && $0.startMs < endMs && $0.endMs > startMs }
    .sorted { $0.startMs < $1.startMs }
  return (allDay, timed)
}

/// The event the menu bar points at: one that started under 10 minutes ago
/// (you may be joining late), else the next to start. Nil when nothing
/// starts within `lookahead` minutes (0 = before the end of today).
func nextUpEvent(_ events: [CalendarEvent], now: Date, lookahead: Int, zone: WorkingZone) -> CalendarEvent? {
  let nowMs = now.ms
  let horizon = lookahead > 0
    ? nowMs + Double(lookahead) * msPerMinute
    : zone.addingDays(1, to: zone.startOfDay(now)).ms
  return events
    .filter { countsForAgenda($0) && !$0.allDay }
    .filter { $0.endMs > nowMs && $0.startMs > nowMs - 10 * msPerMinute && $0.startMs <= horizon }
    .min { $0.startMs < $1.startMs }
}

/// True from a minute before a call starts until 10 minutes in.
func isJoinable(_ event: CalendarEvent, now: Date) -> Bool {
  guard event.conferenceUrl != nil else { return false }
  let nowMs = now.ms
  return nowMs >= event.startMs - msPerMinute && nowMs <= min(event.endMs, event.startMs + 10 * msPerMinute)
}

/// What the menu bar item says of its event, saying which way the time
/// runs: "Standup · in 25m" before it starts, "Standup · 25m left" once it
/// has ("Event in 25m" / "Event · 25m left" without titles). Beside the Join
/// pill there is room for less: the title, or the time alone. Short enough
/// that macOS doesn't push the item into a crowded bar's overflow.
func nextUpText(
  summary: String?, startMs: Double, endMs: Double, now: Date, showTitles: Bool, joining: Bool
) -> String {
  let started = now.ms >= startMs
  let timing = started
    ? "\(countdownText(to: endMs, now: now)) left"
    : "in \(countdownText(to: startMs, now: now))"
  guard showTitles else {
    if joining { return timing }
    return started ? "Event · \(timing)" : "Event \(timing)"
  }
  let limit = joining ? 12 : 20
  var title = (summary?.trimmingCharacters(in: .whitespaces)).flatMap { $0.isEmpty ? nil : $0 } ?? "(No title)"
  if title.count > limit { title = String(title.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…" }
  return joining ? title : "\(title) · \(timing)"
}

/// "now", "12m", "1h 5m", "2h".
func countdownText(to startMs: Double, now: Date) -> String {
  let minutes = Int(((startMs - now.ms) / msPerMinute).rounded(.up))
  if minutes <= 0 { return "now" }
  if minutes < 60 { return "\(minutes)m" }
  let hours = minutes / 60, rest = minutes % 60
  return rest == 0 ? "\(hours)h" : "\(hours)h \(rest)m"
}

/// The companion's clock. Debug builds take `-QaliClockAt 12:59` to start
/// the companion's clock at that time today (e.g. to see a Join pill with
/// fixture events); it then runs on normally.
func companionNow(_ date: Date) -> Date {
  #if DEBUG
    return date.addingTimeInterval(debugClockShift)
  #else
    return date
  #endif
}

#if DEBUG
  private let debugClockShift: TimeInterval = {
    guard let text = UserDefaults.standard.string(forKey: "QaliClockAt") else { return 0 }
    let parts = text.split(separator: ":").compactMap { Int($0) }
    guard parts.count == 2 else { return 0 }
    let now = Date.now
    let target = Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: now) ?? now
    return target.timeIntervalSince(now)
  }()
#endif
