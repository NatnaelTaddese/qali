import Foundation
import Observation
import QaliDomain

/// Where the calendar is looking: the granularity and the page it is anchored
/// on. The toolbar drives it and the grid draws from it, the way the web's
/// `CalendarWeekView` holds `view` and `anchor`.
@Observable
final class CalendarNavigation {
  private(set) var view: CalendarView = .week
  /// The first instant of the page on screen (a day, a week or a month).
  private(set) var anchor: Date
  private(set) var zone: WorkingZone
  private(set) var weekStartsOn: WeekStart
  private(set) var use24h = false

  /// The stored default view is applied once, when preferences first arrive;
  /// after that the view is whatever the user last picked.
  @ObservationIgnored private var appliedDefaultView = false

  init() {
    let zone = WorkingZone(.current)
    self.zone = zone
    weekStartsOn = defaultWeekStart
    anchor = pageStart(.week, .now, weekStartsOn: defaultWeekStart, zone: zone)
    #if DEBUG
      // `-QaliView day|week|month` and `-QaliDate 2026-11-12` open on that
      // view and day, for looking at a page without touching the toolbar.
      let defaults = UserDefaults.standard
      let pinnedView = defaults.string(forKey: "QaliView").flatMap(CalendarView.init(rawValue:))
      let pinnedDay = defaults.string(forKey: "QaliDate").flatMap { text -> Date? in
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return zone.calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
      }
      if pinnedView != nil || pinnedDay != nil {
        view = pinnedView ?? .week
        appliedDefaultView = true
        anchor = pageStart(view, pinnedDay ?? .now, weekStartsOn: defaultWeekStart, zone: zone)
      }
    #endif
  }

  // MARK: What the toolbar shows

  var title: String { viewTitle(view, anchor, zone: zone) }

  /// The ISO week of the page's first day, for the "W46" chip.
  var isoWeek: Int {
    var calendar = Calendar(identifier: .iso8601)
    calendar.timeZone = zone.timeZone
    return calendar.component(.weekOfYear, from: anchor)
  }

  /// The week the month picker highlights.
  var weekStart: Date { pageStart(.week, anchor, weekStartsOn: weekStartsOn, zone: zone) }

  // MARK: What the grid draws

  var days: [Date] { pageDays(view, anchor, weekStartsOn: weekStartsOn, zone: zone) }

  func isToday(_ day: Date) -> Bool { zone.isSameDay(day, .now) }

  /// The window of events to keep loaded around the page. It is quantized to
  /// whole weeks or months, so paging inside it reuses one subscription.
  var eventRange: ClosedRange<Double> {
    let range = eventQueryRange(view, anchor: anchor, weekStartsOn: weekStartsOn, zone: zone)
    return range.startMs...range.endMs
  }

  // MARK: Moving

  func show(_ next: CalendarView) {
    guard next != view else { return }
    // Narrowing a page that holds today lands on today, not on the page's
    // first day: Week to Day should not jump back to Monday.
    let focus = days.contains(where: isToday) ? Date.now : anchor
    view = next
    anchor = pageStart(next, focus, weekStartsOn: weekStartsOn, zone: zone)
  }

  /// One page back (-1) or forward (+1).
  func step(_ direction: Int) {
    anchor = addPages(view, anchor, direction, zone: zone)
  }

  func goToToday() {
    jump(to: .now)
  }

  /// Shows the page containing `day`.
  func jump(to day: Date) {
    anchor = pageStart(view, day, weekStartsOn: weekStartsOn, zone: zone)
  }

  /// Adopts the user's zone, week start and clock, re-cutting the page so it
  /// still holds the same moment.
  func apply(_ preferences: ResolvedPreferences) {
    zone = preferences.zone
    weekStartsOn = preferences.weekStartsOn
    use24h = preferences.use24h
    if !appliedDefaultView {
      appliedDefaultView = true
      if let stored = preferences.raw.defaultView.flatMap(CalendarView.init(rawValue:)) {
        view = stored
      }
      anchor = pageStart(view, .now, weekStartsOn: weekStartsOn, zone: zone)
    } else {
      anchor = pageStart(view, anchor, weekStartsOn: weekStartsOn, zone: zone)
    }
  }
}
