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
  /// The day or week view last shown: the one the month zooms back into.
  private(set) var stripView: CalendarView = .week

  /// What the time grid can do for the toolbar while it is on screen, so the
  /// arrows and Today move the way a swipe lands.
  struct StripControl {
    /// Glides the strip by that many days from where it is heading.
    var step: (Int) -> Void
    /// Brings that day to the leading edge: a glide when it is near, a jump
    /// to a page short of it and a glide the rest of the way when it is not.
    var glide: (Date) -> Void
    /// Scrolls the hours to the current time.
    var revealNow: () -> Void
  }

  @ObservationIgnored var strip: StripControl?

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
        if view != .month { stripView = view }
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

  /// What a change of view keeps in sight: today when the page holds it,
  /// otherwise the page's first day. Narrowing Week to Day should land on
  /// today, not jump back to Monday.
  private var focus: Date { days.contains(where: isToday) ? .now : anchor }

  /// The time grid's page. In month view it is the page that switching back
  /// would open, so the grid is already in place to be zoomed into.
  var stripDays: [Date] {
    guard view == .month else { return days }
    let start = pageStart(stripView, focus, weekStartsOn: weekStartsOn, zone: zone)
    return pageDays(stripView, start, weekStartsOn: weekStartsOn, zone: zone)
  }

  /// The month grid's page. In day and week view it is the month that
  /// switching to Month would open, so the grid is ready to be zoomed out to.
  var monthDays: [Date] {
    guard view != .month else { return days }
    let start = pageStart(.month, focus, weekStartsOn: weekStartsOn, zone: zone)
    return pageDays(.month, start, weekStartsOn: weekStartsOn, zone: zone)
  }

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
    let focus = focus
    view = next
    if next != .month { stripView = next }
    anchor = pageStart(next, focus, weekStartsOn: weekStartsOn, zone: zone)
  }

  /// Moves the day and week views' leftmost day by `days`: the time grid's
  /// horizontal scrolling. A scrolled week starts on any day, as on the web.
  func scroll(days: Int) {
    guard view != .month, days != 0 else { return }
    anchor = zone.addingDays(days, to: anchor)
  }

  /// Days an arrow moves the day and week views: one in Day, three in Week,
  /// as on the web.
  var stepDays: Int { viewNavDays(view) }

  /// Back (-1) or forward (+1): a month in month view, otherwise `stepDays`,
  /// glided by the time grid when it is there to do it.
  func step(_ direction: Int) {
    guard view != .month else {
      anchor = addPages(view, anchor, direction, zone: zone)
      return
    }
    if let strip {
      strip.step(direction * stepDays)
    } else {
      anchor = zone.addingDays(direction * stepDays, to: anchor)
    }
  }

  /// Today, as on the web: the day and week views put today in the middle of
  /// the strip and the hours at the current time; the month view shows this
  /// month.
  func goToToday() {
    guard view != .month, let strip else { return jump(to: .now) }
    strip.glide(zone.addingDays(-(viewColumns(view) / 2), to: zone.startOfDay(.now)))
    strip.revealNow()
  }

  /// Whole days from the anchor to `day` on the working-zone calendar.
  func days(to day: Date) -> Int {
    zone.calendar.dateComponents([.day], from: zone.startOfDay(anchor), to: zone.startOfDay(day)).day ?? 0
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
        if stored != .month { stripView = stored }
      }
      anchor = pageStart(view, .now, weekStartsOn: weekStartsOn, zone: zone)
    } else if view == .week {
      // A scrolled week keeps its leftmost day rather than snapping back to
      // the week's start.
      anchor = zone.startOfDay(anchor)
    } else {
      anchor = pageStart(view, anchor, weekStartsOn: weekStartsOn, zone: zone)
    }
  }
}
