import Foundation

// Port of packages/domain/src/calendar/paging.ts. Every function takes the
// working zone explicitly (TypeScript carried it inside TZDate).

/// date-fns `weekStartsOn` values the app supports: Sunday, Monday, Saturday.
public enum WeekStart: Int, Sendable, CaseIterable {
  case sunday = 0
  case monday = 1
  case saturday = 6
}

/// The app default; the user's stored preference overrides it.
public let defaultWeekStart: WeekStart = .monday

/// The three period granularities the calendar can page through.
public enum CalendarView: String, Sendable, CaseIterable {
  case day, week, month
}

/// Pages of buffer rendered on each side of the anchor, per view.
public func viewBuffer(_ view: CalendarView) -> Int {
  switch view {
  case .day: 7
  case .week: 2
  case .month: 1
  }
}

/// Day columns visible at once in the time-grid views.
public func viewColumns(_ view: CalendarView) -> Int {
  view == .week ? 7 : 1
}

/// Days the navigation buttons move by in the time-grid views.
public func viewNavDays(_ view: CalendarView) -> Int {
  view == .week ? 3 : 1
}

/// Extra day columns rendered off-screen on each side of the visible window.
public func stripSideDays(_ view: CalendarView) -> Int {
  viewBuffer(view) * viewColumns(view)
}

/// The full day columns of a strip: `side` off-screen days, the visible
/// window, then `side` more. The anchor (leftmost visible day) sits at `side`.
/// (TypeScript interns these for React memoization; `Date` is a value here.)
public func stripDays(anchor: Date, columns: Int, side: Int, zone: WorkingZone) -> [Date] {
  (0..<(side + columns + side)).map { zone.addingDays($0 - side, to: anchor) }
}

/// Weeks of events fetched each side of the anchor's week, for the strips.
public let querySideWeeks = 2 * viewBuffer(.week) + 1
/// Months of events fetched each side of the anchor's month, for month view.
public let querySideMonths = 2 * viewBuffer(.month) + 1

/// The event-query window for an anchor, quantized to a week (strip views) or
/// month boundary so scrolling within it reuses the identical Convex
/// subscription. For a custom strip of `columns` visible days with `side`
/// buffered days each side, the `.week` window covers every reachable strip as
/// long as `2 * side + columns <= 35`.
public func eventQueryRange(
  _ view: CalendarView,
  anchor: Date,
  weekStartsOn: WeekStart = defaultWeekStart,
  zone: WorkingZone
) -> (startMs: Double, endMs: Double) {
  if view == .month {
    let base = zone.startOfMonth(anchor)
    return (
      zone.addingMonths(-querySideMonths, to: base).ms,
      zone.addingMonths(querySideMonths + 1, to: base).ms
    )
  }
  let base = zone.startOfWeek(anchor, weekStartsOn: weekStartsOn)
  return (
    zone.addingWeeks(-querySideWeeks, to: base).ms,
    zone.addingWeeks(querySideWeeks + 1, to: base).ms
  )
}

/// Normalize a date to the start of its page for the given view.
public func pageStart(
  _ view: CalendarView,
  _ date: Date,
  weekStartsOn: WeekStart = defaultWeekStart,
  zone: WorkingZone
) -> Date {
  switch view {
  case .day: zone.startOfDay(date)
  case .week: zone.startOfWeek(date, weekStartsOn: weekStartsOn)
  case .month: zone.startOfMonth(date)
  }
}

/// Shift a page start by `n` pages (days / weeks / months).
public func addPages(_ view: CalendarView, _ start: Date, _ n: Int, zone: WorkingZone) -> Date {
  switch view {
  case .day: zone.addingDays(n, to: start)
  case .week: zone.addingWeeks(n, to: start)
  case .month: zone.addingMonths(n, to: start)
  }
}

/// The days rendered by a single page. Month pages span a fixed 6×7 grid.
public func pageDays(
  _ view: CalendarView,
  _ start: Date,
  weekStartsOn: WeekStart = defaultWeekStart,
  zone: WorkingZone
) -> [Date] {
  switch view {
  case .day:
    return [start]
  case .week:
    return (0..<7).map { zone.addingDays($0, to: start) }
  case .month:
    let gridStart = zone.startOfWeek(start, weekStartsOn: weekStartsOn)
    return (0..<42).map { zone.addingDays($0, to: gridStart) }
  }
}

/// Human title for the currently anchored page.
public func viewTitle(_ view: CalendarView, _ start: Date, zone: WorkingZone) -> String {
  switch view {
  case .day: zone.format(start, "EEEE, MMM d, yyyy")
  case .month: zone.format(start, "MMMM yyyy")
  case .week: spanTitle(start, zone.addingDays(6, to: start), zone: zone)
  }
}

/// Human title for an inclusive day span: one month name when both ends share
/// it, otherwise "Sep – Oct 2026" / "Dec 2026 – Jan 2027".
public func spanTitle(_ start: Date, _ last: Date, zone: WorkingZone) -> String {
  if zone.isSameMonth(start, last) { return zone.format(start, "MMMM yyyy") }
  let firstPattern = zone.isSameYear(start, last) ? "MMM" : "MMM yyyy"
  return "\(zone.format(start, firstPattern)) – \(zone.format(last, "MMM yyyy"))"
}
