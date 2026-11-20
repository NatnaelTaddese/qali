import Foundation
import Observation
import QaliDomain

/// Where the calendar is looking: the granularity and the page it is anchored
/// on. The toolbar drives it and the grid draws from it, the way the web's
/// `CalendarWeekView` holds `view` and `anchor`.
@Observable
final class CalendarNavigation {
  private(set) var view: CalendarView = .week
  /// The first instant of the page on screen: a day, a week, or in month
  /// view the start of the grid's top week row (the month grid scrolls by
  /// weeks, so its top row need not hold the 1st).
  private(set) var anchor: Date {
    // Any move but the strip's own hand-over starts the page afresh, with
    // nothing scrolled past it.
    didSet { if !handingOver, scrolledDays != 0 { scrolledDays = 0 } }
  }
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
    /// Scrolls the hours so that hour of the day (0…24) sits in the upper
    /// part of the window.
    var revealHour: (Double) -> Void
    /// Whether the strip is swiping or gliding.
    var isMoving: () -> Bool
  }

  @ObservationIgnored var strip: StripControl?

  /// True while the grid zooms to or from the month: the weekday labels and
  /// the page's date numbers then travel between the two grids instead of
  /// fading, and the time grid hides its own copies under them.
  var zooming = false
  /// Which zoom `zooming` belongs to, so an older one finishing late
  /// doesn't clear a newer one's.
  @ObservationIgnored var zoomToken = 0

  /// The month grid's own glide, while it is on screen: moves its top row
  /// that many weeks on from where it is heading, and says how many weeks
  /// ahead of the anchor that is.
  struct MonthControl {
    var glide: (Int) -> Void
    var heading: () -> Int
    /// Whether the rows are swiping or gliding.
    var isMoving: () -> Bool = { false }
  }

  @ObservationIgnored var monthStrip: MonthControl?

  /// The item last reached for, which its card (or month cell) flashes.
  private(set) var reveal = Reveal.none
  /// A flash waiting for a glide to land.
  @ObservationIgnored private var pendingFlash: String?

  /// The month grid last shown (its top row's week start), so zooming back
  /// out of a day or week returns to the grid as it was scrolled.
  @ObservationIgnored private var lastMonthGrid: Date?

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
        if view == .month { anchor = monthGridStart(anchor) }
      }
    #endif
  }

  // MARK: What the toolbar shows

  var title: String { viewTitle(view, view == .month ? shownMonth : shownAnchor, zone: zone) }

  /// Whole days the day and week views' strip is scrolled past the anchor.
  /// The strip runs on several days before handing them over to the anchor
  /// (each hand-over rebuilds the grid), so the toolbar reads the page in
  /// view from here instead. Set only when it changes.
  private(set) var scrolledDays = 0
  @ObservationIgnored private var handingOver = false

  /// The leftmost day in view: the anchor plus what the strip has scrolled
  /// past it. In month view, the anchor.
  var shownAnchor: Date {
    view == .month || scrolledDays == 0 ? anchor : zone.addingDays(scrolledDays, to: anchor)
  }

  /// The time grid reports how many whole days past its anchor it shows.
  func setStripScroll(days: Int) {
    let value = view == .month ? 0 : days
    if value != scrolledDays { scrolledDays = value }
  }

  /// The month the month grid is showing: the one holding its third row, as
  /// the grid's in-month shading reads it.
  var shownMonth: Date {
    if view == .month, let scrolledMonth { return scrolledMonth }
    return zone.startOfMonth(view == .month ? zone.addingDays(15, to: anchor) : anchor)
  }

  /// While the month scrolls, the grid runs a few weeks past its anchor
  /// before handing them over (`MonthGrid`): the month then in view, when it
  /// differs from the anchor's. Set only when it changes, so the title
  /// follows the scroll without redrawing the grid every week.
  private(set) var scrolledMonth: Date?
  /// Whole weeks the month grid is scrolled past its anchor.
  @ObservationIgnored private var monthScrollWeeks = 0

  /// The month grid reports how many whole weeks past its anchor it shows.
  func setMonthScroll(weeks: Int) {
    monthScrollWeeks = weeks
    updateScrolledMonth()
  }

  private func updateScrolledMonth() {
    let visible = zone.startOfMonth(zone.addingDays(7 * monthScrollWeeks + 15, to: anchor))
    let anchored = zone.startOfMonth(zone.addingDays(15, to: anchor))
    let value = monthScrollWeeks == 0 || visible == anchored ? nil : visible
    if value != scrolledMonth { scrolledMonth = value }
  }

  /// The top row of the plain grid for the month holding `day`.
  private func monthGridStart(_ day: Date) -> Date {
    zone.startOfWeek(zone.startOfMonth(day), weekStartsOn: weekStartsOn)
  }

  /// The ISO week of the page's first day, for the "W46" chip.
  var isoWeek: Int {
    var calendar = Calendar(identifier: .iso8601)
    calendar.timeZone = zone.timeZone
    return calendar.component(.weekOfYear, from: shownAnchor)
  }

  /// The week the month picker highlights.
  var weekStart: Date {
    pageStart(.week, view == .month ? shownMonth : shownAnchor, weekStartsOn: weekStartsOn, zone: zone)
  }

  // MARK: What the grid draws

  var days: [Date] { pageDays(view, anchor, weekStartsOn: weekStartsOn, zone: zone) }

  /// What a change of view keeps in sight: today when the page holds it,
  /// otherwise the page's first day. Narrowing Week to Day should land on
  /// today, not jump back to Monday.
  /// In month view, the first day of the shown month that is on the grid.
  private var focus: Date { focus(scrolled: false) }

  /// `focus`, from the page in view when `scrolled` (a strip scrolled past
  /// its anchor shows a later page than `days`).
  private func focus(scrolled: Bool) -> Date {
    let start = scrolled ? shownAnchor : anchor
    let days = scrolled ? pageDays(view, start, weekStartsOn: weekStartsOn, zone: zone) : days
    if days.contains(where: isToday) { return .now }
    guard view == .month else { return start }
    let month = shownMonth
    return days.first { zone.isSameMonth($0, month) } ?? anchor
  }

  /// The time grid's page. In month view it is the page that switching back
  /// would open, so the grid is already in place to be zoomed into.
  var stripDays: [Date] {
    guard view == .month else { return days }
    // Held while the month scrolls: it only matters for zooming back in,
    // and the hidden time grid would otherwise be rebuilt every few weeks
    // of a scroll, stalling it.
    if let heldStripDays { return heldStripDays }
    let start = pageStart(stripView, focus, weekStartsOn: weekStartsOn, zone: zone)
    return pageDays(stripView, start, weekStartsOn: weekStartsOn, zone: zone)
  }

  /// `stripDays` and `eventRange` as they were when the month started
  /// scrolling, until it lands. (The strip page isn't observed: it equals
  /// the live one when set, and the landing moves the anchor anyway.)
  @ObservationIgnored private var heldStripDays: [Date]?
  private var heldEventRange: ClosedRange<Double>?

  /// The month grid reports its scroll starting and landing.
  func monthScrolling(_ moving: Bool) {
    if moving {
      if heldStripDays == nil { heldStripDays = stripDays }
      if heldEventRange == nil { heldEventRange = eventRange }
    } else {
      heldStripDays = nil
      heldEventRange = nil
    }
  }

  /// The month grid's page. In day and week view it is the month that
  /// switching to Month would open, so the grid is ready to be zoomed out to.
  var monthDays: [Date] {
    guard view != .month else { return days }
    return pageDays(.month, monthGrid(around: focus), weekStartsOn: weekStartsOn, zone: zone)
  }

  /// The month grid that holds `day`: the one last shown when the day is on
  /// it, otherwise that day's own month.
  private func monthGrid(around day: Date) -> Date {
    if let last = lastMonthGrid, day >= last, day < zone.addingDays(42, to: last) { return last }
    return monthGridStart(day)
  }

  /// Spare weeks the month grid draws above and below its six rows, for a
  /// scroll to run into before the grid is rebuilt (see `MonthGrid`).
  static let monthSpareWeeks = 4

  /// The weeks the month grid draws: its six rows and the spare weeks.
  var monthBufferDays: [Date] {
    let spare = Self.monthSpareWeeks
    let first = zone.addingDays(-7 * spare, to: monthDays.first ?? anchor)
    return (0..<(7 * (6 + 2 * spare))).map { zone.addingDays($0, to: first) }
  }

  func isToday(_ day: Date) -> Bool { zone.isSameDay(day, .now) }

  /// The window of events to keep loaded around the page. It is quantized to
  /// whole weeks or months, so paging inside it reuses one subscription.
  var eventRange: ClosedRange<Double> {
    // Held while the month scrolls, so crossing into another month doesn't
    // swap the subscription mid-glide; a fling stays well inside it.
    if let heldEventRange { return heldEventRange }
    let range = eventQueryRange(view, anchor: view == .month ? shownMonth : anchor, weekStartsOn: weekStartsOn, zone: zone)
    return range.startMs...range.endMs
  }

  // MARK: Moving

  func show(_ next: CalendarView) {
    guard next != view else { return }
    let focus = focus(scrolled: true)
    if view == .month { lastMonthGrid = anchor }
    view = next
    if next != .month { stripView = next }
    anchor = next == .month ? monthGrid(around: focus) : pageStart(next, focus, weekStartsOn: weekStartsOn, zone: zone)
  }

  /// Zooms the month into one day: the day view on it, as clicking a day
  /// cell does on the web.
  func open(day: Date) {
    if view == .month { lastMonthGrid = anchor }
    view = .day
    stripView = .day
    anchor = zone.startOfDay(day)
  }

  /// Moves the month grid's top row by `weeks`: the month view's vertical
  /// scrolling.
  func scroll(weeks: Int) {
    guard view == .month, weeks != 0 else { return }
    anchor = zone.addingWeeks(weeks, to: anchor)
    // The handed-over weeks are no longer past the anchor.
    monthScrollWeeks -= weeks
    updateScrolledMonth()
  }

  /// Whole weeks from the month grid's top row to the week starting `day`.
  private func weeks(to day: Date) -> Int {
    Int((Double(days(to: day)) / 7).rounded())
  }

  /// Moves the day and week views' leftmost day by `days`: the time grid's
  /// horizontal scrolling. A scrolled week starts on any day, as on the web.
  func scroll(days: Int) {
    guard view != .month, days != 0 else { return }
    handingOver = true
    anchor = zone.addingDays(days, to: anchor)
    handingOver = false
    // The handed-over days are no longer past the anchor.
    setStripScroll(days: scrolledDays - days)
  }

  /// Days an arrow moves the day and week views: one in Day, three in Week,
  /// as on the web.
  var stepDays: Int { viewNavDays(view) }

  /// Back (-1) or forward (+1): a month in month view, otherwise `stepDays`,
  /// glided by the time grid when it is there to do it.
  func step(_ direction: Int) {
    guard view != .month else {
      // To the next or previous month's plain grid, from where a glide is
      // already heading, so quick presses add up.
      let heading = zone.addingWeeks(monthStrip?.heading() ?? 0, to: anchor)
      let month = zone.addingMonths(direction, to: zone.startOfMonth(zone.addingDays(15, to: heading)))
      let destination = monthGridStart(month)
      if let monthStrip { monthStrip.glide(weeks(to: destination)) } else { anchor = destination }
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
    if view == .month, let monthStrip {
      // Glide when today's month is near, jump when it is not.
      let weeks = weeks(to: monthGridStart(.now))
      if abs(weeks) <= 10 { return monthStrip.glide(weeks) }
    }
    guard view != .month, let strip else { return jump(to: .now) }
    strip.glide(zone.addingDays(-(viewColumns(view) / 2), to: zone.startOfDay(.now)))
    strip.revealNow()
  }

  /// Reaches for an event on the grid, as the web's `revealItem` does for a
  /// notification: the day and week views centre its day among the columns
  /// and ease the hours to its start; the month view brings its week into
  /// the rows and flashes the whole day cell. The flash waits for the glide
  /// to land.
  func reveal(_ event: CalendarEvent) {
    let day = Date(ms: event.allDay ? fromUtcMidnight(event.startMs, zone: zone) : event.startMs)
    if view == .month {
      pendingFlash = Self.dayKey(day, zone: zone)
      let weeks = weeks(to: monthGridStart(day))
      if let monthStrip, abs(weeks) <= 10 {
        if weeks != 0 { monthStrip.glide(weeks) }
        if !monthStrip.isMoving() { flashPending() }
      } else {
        jump(to: day)
        flashPending()
      }
      return
    }
    pendingFlash = event.id
    guard let strip else {
      jump(to: day)
      return flashPending()
    }
    let lead = zone.addingDays(-(viewColumns(view) / 2), to: zone.startOfDay(day))
    if days(to: lead) != 0 { strip.glide(lead) }
    if !event.allDay {
      strip.revealHour(Date(ms: event.startMs).timeIntervalSince(zone.startOfDay(day)) / 3600)
    }
    if !strip.isMoving() { flashPending() }
  }

  /// Reaches for a booking request the way `reveal(_:)` does for a timed
  /// event: its day among the columns, the hours eased to its start, and a
  /// flash on its block. The month view has no request blocks, so it opens
  /// the request's week.
  func reveal(booking: Booking) {
    let day = Date(ms: booking.startMs)
    if view == .month { show(.week) }
    pendingFlash = booking.id
    guard let strip else {
      jump(to: day)
      return flashPending()
    }
    let lead = zone.addingDays(-(viewColumns(view) / 2), to: zone.startOfDay(day))
    if days(to: lead) != 0 { strip.glide(lead) }
    strip.revealHour(day.timeIntervalSince(zone.startOfDay(day)) / 3600)
    if !strip.isMoving() { flashPending() }
  }

  /// The grids call this when a swipe or glide lands.
  func stripSettled() {
    if pendingFlash != nil { flashPending() }
  }

  private func flashPending() {
    guard let id = pendingFlash else { return }
    pendingFlash = nil
    reveal = Reveal(id: id, nonce: reveal.nonce + 1, at: .now)
  }

  /// A month cell's reveal key.
  static func dayKey(_ day: Date, zone: WorkingZone) -> String { "day:" + zone.format(day, "yyyy-MM-dd") }

  /// Whole days from the anchor to `day` on the working-zone calendar.
  func days(to day: Date) -> Int {
    zone.calendar.dateComponents([.day], from: zone.startOfDay(anchor), to: zone.startOfDay(day)).day ?? 0
  }

  /// Shows the page containing `day`.
  func jump(to day: Date) {
    anchor = view == .month ? monthGridStart(day) : pageStart(view, day, weekStartsOn: weekStartsOn, zone: zone)
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
      anchor = view == .month ? monthGridStart(.now) : pageStart(view, .now, weekStartsOn: weekStartsOn, zone: zone)
    } else if view == .month {
      // A scrolled month keeps its rows, re-cut to the week start.
      anchor = zone.startOfWeek(anchor, weekStartsOn: weekStartsOn)
      lastMonthGrid = nil
    } else if view == .week {
      // A scrolled week keeps its leftmost day rather than snapping back to
      // the week's start.
      anchor = zone.startOfDay(anchor)
    } else {
      anchor = pageStart(view, anchor, weekStartsOn: weekStartsOn, zone: zone)
    }
  }
}
