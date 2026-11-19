import QaliDomain
import SwiftUI

/// The month view (the web's `MonthPanel`): weekday labels over a 6×7 grid of
/// day cells, each listing as many of its events as fit and counting the rest.
///
/// Its rows and columns are placed by a `MonthZoomLayout`, so the same grid
/// can open one week (or one day) out to the time grid's shape and close it
/// back; see `CalendarGrid`.
///
/// A trackpad swipe scrolls it up and down a week row at a time, springing
/// onto a row like Calendar's month view (a `StripScroller` in vertical
/// mode); the title follows the month in view. Clicking a day zooms into it.
struct MonthGrid: View, Equatable {
  let days: [Date]
  /// `days` with one more week above and below, drawn while scrolling.
  let bufferDays: [Date]
  let layout: MonthZoomLayout
  let navigation: CalendarNavigation
  let data: CalendarData
  /// Shared with the time grid, whose day strip the focused dates start from.
  let zoom: Namespace.ID
  /// Whether the month is the view: when not, it is hidden but for the
  /// pieces that travel during a zoom.
  let shown: Bool

  /// Web metrics (MONTH_EVENT_ROW_HEIGHT / MONTH_EVENT_ROW_GAP).
  fileprivate static let rowHeight: CGFloat = 18
  fileprivate static let rowGap: CGFloat = 2
  /// The day number's box and the cell's padding around its content.
  fileprivate static let numberSize: CGFloat = 24
  /// The day strip's number box (`DayHeader`): a travelling number grows to
  /// it, so it lands exactly where the strip's own number sits.
  fileprivate static let stripNumberSize: CGFloat = 28
  fileprivate static let padding: CGFloat = 4

  @State private var scroller = StripScroller()

  static func == (a: Self, b: Self) -> Bool {
    a.days == b.days && a.bufferDays == b.bufferDays && a.layout == b.layout && a.shown == b.shown
      && a.zoom == b.zoom
  }
  /// The last bucketing of events by day: the grid is rebuilt for many
  /// reasons (weeks handed over, the month in view changing) that leave
  /// the events and days alone.
  @State private var buckets = MonthBuckets()

  var body: some View {
    // What is left of a resting cell for events, under the day number.
    let eventArea = layout.restingCellHeight - Self.padding * 2 - Self.numberSize - Self.rowGap
    // The scroll offset itself is read only by `MonthTrack`, so a scroll
    // frame moves the rows without re-evaluating this body. Nothing here
    // reads whether it is scrolling either: starting a swipe costs nothing.
    // The page's events, sorted once and bucketed by day in one pass.
    let byDay = buckets.get(data.events, days: bufferDays, zone: navigation.zone)
    // The six rows and the spare weeks either side, always: the scroller
    // hands weeks over to the anchor (rebuilding this) only every few.
    let spare = CalendarNavigation.monthSpareWeeks
    let cells = Array(bufferDays.enumerated()).map { ($0.offset - 7 * spare, $0.element) }
    ZStack(alignment: .topLeading) {
      HeaderBand {
        Color.clear.frame(height: layout.headerHeight)
      }
      .modifier(fade)
      ForEach(Array(days.prefix(7).enumerated()), id: \.offset) { column, day in
        // The page's labels travel to and from the day strip's; the rest
        // fade with the grid.
        let travels = layout.focusColumn.map { $0 == column } ?? true
        let focusDay = days[min(layout.focusRow * 7 + column, days.count - 1)]
        // Today's label is darker in the strip; it eases between the two.
        let stripToday = travels && layout.expanded && navigation.isToday(focusDay)
        Text(navigation.zone.format(day, "EEE").uppercased())
          .font(.sans(TextSize.xs, .medium))
          .tracking(0.3)
          .foregroundStyle(stripToday ? Palette.foreground : Palette.mutedForeground)
          .fixedSize()
          .matchedGeometryEffect(
            id: travels && layout.expanded ? ZoomID.weekday(focusDay, zone: navigation.zone) : "month-weekday-\(column)",
            in: zoom,
            isSource: false
          )
          .modifier(travels ? MonthFade(visible: shown || navigation.zooming, animation: nil) : fade)
          .padding(.horizontal, 8)
          .frame(width: layout.width(column: column), height: layout.headerHeight, alignment: .leading)
          .clipped()
          .offset(x: layout.x(column: column))
      }
      MonthTrack(scroller: scroller, active: !layout.expanded) {
       MonthHoverHost(layout: layout) {
       ZStack(alignment: .topLeading) {
        ForEach(cells, id: \.1) { index, day in
          let row = Int((Double(index) / 7).rounded(.down))
          let column = (index % 7 + 7) % 7
          MonthDayCell(
            day: day,
            events: byDay[day] ?? [],
            eventArea: eventArea,
            focused: isFocused(row: row, column: column),
            spare: row < 0 || row >= layout.rows,
            today: navigation.isToday(day),
            expanded: layout.expanded,
            restingSize: CGSize(width: layout.restingCellWidth, height: layout.restingCellHeight),
            shown: shown,
            fade: fade,
            zoom: zoom,
            navigation: navigation,
            data: data,
            open: open
          )
          .equatable()
            .frame(width: layout.width(column: column), height: layout.height(row: row), alignment: .topLeading)
            .offset(x: layout.x(column: column), y: layout.headerHeight + layout.y(row: row))
        }
      }
       .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
       }
      }
      // Rows scrolled up pass under the weekday header; not while zooming,
      // which carries the focused day numbers up into it. (A clip, not a
      // mask: a mask renders offscreen every frame.)
      .clipShape(InsetRect(top: layout.expanded || navigation.zooming ? -4000 : layout.headerHeight))
    }
    .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
    .clipped()
    .background { StripScrollCatcher(scroller: scroller) }
    .onAppear(perform: configureScroller)
    #if DEBUG
      // `-QaliMonthStep 2` glides the rows two weeks after launch;
      // `-QaliZoomDay 2026-11-20` zooms into that day, for captures.
      .task {
        let defaults = UserDefaults.standard
        try? await Task.sleep(for: .seconds(1.5))
        let weeks = defaults.integer(forKey: "QaliMonthStep")
        if weeks != 0 { scroller.step(days: weeks) }
        if let text = defaults.string(forKey: "QaliZoomDay"),
          let day = bufferDays.first(where: { navigation.zone.format($0, "yyyy-MM-dd") == text })
        {
          try? await Task.sleep(for: .seconds(weeks != 0 ? 1.5 : 0))
          open(day)
        }
      }
    #endif
    .onChange(of: layout.restingCellHeight) { configureScroller() }
    .onChange(of: layout.expanded) { configureScroller() }
    .environment(\.reveal, navigation.reveal)
    .onChange(of: navigation.anchor) { _, anchor in
      // A page change from the toolbar or a shortcut starts the rows afresh.
      if anchor != scroller.ownAnchor { scroller.reset() }
    }
  }

  /// How the parts of the grid that don't travel come and go: in quickly as
  /// the week shrinks, and out quickly as it grows back (the time grid is
  /// already in underneath), before its chips can sweep up through the
  /// header.
  private var fade: MonthFade {
    let duration = CalendarNavigation.zoomDuration
    return MonthFade(
      visible: shown,
      animation: shown ? .easeOut(duration: duration * 0.3) : .easeOut(duration: duration * 0.3)
    )
  }

  private func configureScroller() {
    scroller.vertical = true
    scroller.columnWidth = max(layout.restingCellHeight, 1)
    scroller.isEnabled = !layout.expanded
    scroller.maxFlingDays = 12
    scroller.handOver = CGFloat(CalendarNavigation.monthSpareWeeks) - 0.5
    scroller.shiftAnchor = { [navigation, scroller] weeks in
      navigation.scroll(weeks: weeks)
      scroller.ownAnchor = navigation.anchor
    }
    // Straight from the scroller rather than through `onChange`, so that
    // nothing this grid's body reads changes as weeks go by.
    scroller.reportVisibleSteps = { [navigation] weeks in navigation.setMonthScroll(weeks: weeks) }
    scroller.reportMoving = { [navigation] moving in
      navigation.monthScrolling(moving)
      if !moving { navigation.stripSettled() }
    }
    navigation.monthStrip = layout.expanded
      ? nil
      : .init(
        glide: { [scroller] weeks in scroller.glide(toDay: weeks) },
        heading: { [scroller] in scroller.heading },
        isMoving: { [scroller] in scroller.isMoving }
      )
  }

  /// Zooms into a day; a click mid-glide lands the rows first.
  private func open(_ day: Date) {
    scroller.reset()
    navigation.openAnimated(day: day)
  }

  /// Whether the cell belongs to the time grid's page: its week, or its day.
  private func isFocused(row: Int, column: Int) -> Bool {
    row == layout.focusRow && (layout.focusColumn ?? column) == column
  }

  /// Each day's events, all-day first and then by start, in one pass over
  /// the events (`days` is consecutive).
  fileprivate static func bucket(_ events: [CalendarEvent], days: [Date], zone: WorkingZone) -> [Date: [CalendarEvent]] {
    guard let first = days.first else { return [:] }
    let sorted = events.sorted { a, b in
      if a.allDay != b.allDay { return a.allDay }
      return a.startMs < b.startMs
    }
    // Day boundaries in the working zone, and the same calendar dates at UTC
    // midnight: all-day boundaries are UTC-midnight instants, so they are
    // compared in UTC; a working-zone offset would spill a single-day chip
    // into the neighbouring cell.
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    let starts = days.map(\.ms) + [zone.addingDays(days.count, to: first).ms]
    let utcStarts = days.map { day -> Double in
      let parts = zone.calendar.dateComponents([.year, .month, .day], from: day)
      return utc.date(from: parts)?.ms ?? day.ms
    }
    var buckets = [[CalendarEvent]](repeating: [], count: days.count)
    for event in sorted {
      for index in days.indices {
        let hit = event.allDay
          ? event.startMs <= utcStarts[index] && utcStarts[index] < event.endMs
          : event.startMs < starts[index + 1] && event.endMs > starts[index]
        if hit { buckets[index].append(event) }
      }
    }
    var result: [Date: [CalendarEvent]] = [:]
    for (index, day) in days.enumerated() where !buckets[index].isEmpty { result[day] = buckets[index] }
    return result
  }

  /// How many events fit, keeping the last row for the "+N more" count when
  /// they do not all fit (the web's `visibleMonthEventMetrics`).
  fileprivate static func visibleEvents(count: Int, availableHeight: CGFloat) -> (visible: Int, hidden: Int) {
    let rows = max(Int((availableHeight + rowGap) / (rowHeight + rowGap)), 0)
    let visible = count <= rows ? count : max(rows - 1, 0)
    return (visible, count - visible)
  }
}

private struct MonthChip: View {
  let event: CalendarEvent
  let hue: Color

  var body: some View {
    HStack(spacing: 4) {
      Circle()
        .fill(hue)
        .frame(width: 6, height: 6)
      Text(event.title)
        .font(.sans(TextSize.xs))
        .lineLimit(1)
    }
    .padding(.horizontal, 4)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .background { EventTint(hue: hue, strength: 0.18) }
    .clipShape(.rect(cornerRadius: 4))
    .help(event.title)
    .opensEvent(event)
  }
}

/// Shows or hides part of the month grid, with its own timing when given one
/// (an opacity animation scoped to just this modifier).
private struct MonthFade: ViewModifier, Equatable {
  let visible: Bool
  let animation: Animation?

  func body(content: Content) -> some View {
    content.animation(animation) { $0.opacity(visible ? 1 : 0) }
  }
}

/// Shifts the month's rows by the scroller's offset. It alone reads the
/// offset, so a scroll frame re-renders this wrapper and not the grid. (A
/// view, not a modifier: what a modifier reads is charged to its host.)
private struct MonthTrack<Content: View>: View {
  let scroller: StripScroller
  let active: Bool
  @ViewBuilder var content: Content
  /// Made with the grid's render: see `ScrollContent`.
  private let render = ScrollContent<Content>.Render()

  var body: some View {
    ScrollContent(render: render, content: content)
      .equatable()
      .offset(y: active ? -scroller.offset : 0)
      // Off while the rows move: the pointer's hover would otherwise be
      // hit-tested against every cell and chip again on each frame.
      .allowsHitTesting(!scroller.isMoving)
      // Scrolling is never animated by SwiftUI.
      .animation(nil, value: scroller.offset)
  }
}

/// The rows plus the tint on the cell under the pointer, tracked once for
/// the whole grid (a hover region on every cell would all be hit-tested
/// again on every frame of a scroll, as the rows move under the pointer).
/// The hovered cell is this view's own state, so the pointer crossing cells
/// redraws only the tint, never the rows.
private struct MonthHoverHost<Content: View>: View {
  struct Cell: Equatable {
    var row: Int
    var column: Int
  }

  let layout: MonthZoomLayout
  @ViewBuilder var content: Content
  /// Made with the grid's render: see `ScrollContent`.
  private let render = ScrollContent<Content>.Render()
  @State private var cell: Cell?

  var body: some View {
    ScrollContent(render: render, content: content)
      .equatable()
      .background(alignment: .topLeading) {
        if let cell, !layout.expanded {
          Palette.foreground.opacity(0.04)
            .frame(width: layout.restingCellWidth, height: layout.restingCellHeight)
            .offset(
              x: CGFloat(cell.column) * layout.restingCellWidth,
              y: layout.headerHeight + CGFloat(cell.row) * layout.restingCellHeight
            )
            .allowsHitTesting(false)
        }
      }
      // In the rows' own coordinates, which move with the scroll.
      .onContinuousHover(coordinateSpace: .local) { phase in
        let next = hoveredCell(phase)
        if next != cell { cell = next }
      }
  }

  /// The resting grid's cell (row, column) under the pointer, rows counted
  /// from the six rows' top (spare weeks above are negative).
  private func hoveredCell(_ phase: HoverPhase) -> Cell? {
    guard case .active(let point) = phase, !layout.expanded else { return nil }
    let width = layout.restingCellWidth, height = layout.restingCellHeight
    guard width > 0, height > 0, point.y >= layout.headerHeight else { return nil }
    let row = Int(((point.y - layout.headerHeight) / height).rounded(.down))
    let column = Int((point.x / width).rounded(.down))
    let spare = CalendarNavigation.monthSpareWeeks
    guard (-spare..<(layout.rows + spare)).contains(row), (0..<7).contains(column) else { return nil }
    return .init(row: row, column: column)
  }

}

/// A rectangle grown or shrunk by its insets: negative ones reach past the
/// frame, so a clip can let a travelling number out.
nonisolated private struct InsetRect: Shape {
  var top: CGFloat = 0
  var rest: CGFloat = 0

  init(top: CGFloat) { self.top = top }
  init(all: CGFloat) { top = all; rest = all }

  func path(in rect: CGRect) -> Path {
    Path(CGRect(x: rect.minX + rest, y: rect.minY + top, width: rect.width - 2 * rest, height: rect.height - top - rest))
  }
}

/// One day of the month grid. Equatable, so when the grid is rebuilt (a
/// scroll handing weeks over, new events) only the cells whose own inputs
/// changed are redrawn.
private struct MonthDayCell: View, Equatable {
  let day: Date
  let events: [CalendarEvent]
  let eventArea: CGFloat
  /// On the time grid's page: its number travels during a zoom.
  let focused: Bool
  /// One of the spare weeks drawn past the six rows for scrolling. Hidden
  /// during a zoom, which lifts the clip under the weekday header.
  let spare: Bool
  let today: Bool
  let expanded: Bool
  /// The resting cell's size, at which the content is always laid out.
  let restingSize: CGSize
  let shown: Bool
  let fade: MonthFade
  let zoom: Namespace.ID
  let navigation: CalendarNavigation
  let data: CalendarData
  let open: (Date) -> Void

  static func == (a: Self, b: Self) -> Bool {
    a.day == b.day && a.events == b.events && a.eventArea == b.eventArea && a.focused == b.focused && a.spare == b.spare
      && a.today == b.today && a.expanded == b.expanded
      && a.restingSize == b.restingSize && a.shown == b.shown && a.fade == b.fade && a.zoom == b.zoom
  }

  private typealias M = MonthGrid

  var body: some View {
    // Read here, not passed in: as the month in view changes mid-scroll,
    // only the cells redraw their shading and numbers, not the grid.
    let inMonth = navigation.zone.isSameMonth(day, navigation.shownMonth)
    ZStack(alignment: .topLeading) {
      // Its own equatable view: the month in view changing, or a scroll
      // handing weeks over, changes the cell's shading and number but not
      // its events, so the chips are left alone.
      MonthCellEvents(events: events, eventArea: eventArea, data: data)
        .equatable()
      .padding(M.padding)
      // Laid out at the resting cell's size whatever the zoom, and uncovered
      // by the cell's frame, so chips never re-wrap while a column or row
      // opens up.
      .frame(width: restingSize.width, height: restingSize.height, alignment: .topLeading)
      .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
      // Under the chips, as on the web.
      .background { Color.clear.revealFlash([CalendarNavigation.dayKey(day, zone: navigation.zone)], strength: 0.28) }
      .background(inMonth ? Color.clear : Palette.muted.opacity(0.3))
      .overlay(alignment: .leading) { Palette.border.frame(width: 1) }
      .overlay(alignment: .bottom) { Palette.border.frame(height: 1) }
      .clipped()
      .modifier(fade)

      // The page's numbers travel to and from the day strip's.
      number
        .padding(M.padding)
        .modifier(focused ? MonthFade(visible: shown || navigation.zooming, animation: nil) : fade)
    }
    // A squeezed-shut cell hides everything it holds, except in the focused
    // week, whose dates arrive from the day strip above the grid.
    // (Not a conditional clip, so the cell keeps one identity.)
    .clipShape(InsetRect(all: focused ? -4000 : 0))
    .opacity(spare && navigation.zooming ? 0 : 1)
    .contentShape(.rect)
    .onTapGesture { open(day) }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(navigation.zone.format(day, "EEEE, MMMM d") + (today ? ", today" : ""))
    .accessibilityAddTraits(.isButton)
    .accessibilityAction { open(day) }
  }

  /// The day number. While the time grid is showing, the numbers of its page
  /// sit exactly on the day strip's own numbers; zooming out to the month
  /// lets go of them, and they glide down into their cells.
  private var number: some View {
    let follows = expanded && focused
    let text = navigation.zone.format(day, "d")
    let inMonth = navigation.zone.isSameMonth(day, navigation.shownMonth)
    let monthColor = today ? Palette.primaryForeground : inMonth ? Palette.foreground : Palette.mutedForeground
    // A travelling number is drawn twice, in the strip's type and in the
    // month's, both scaled to the same size and crossfaded over the zoom, so
    // its size, weight and colour all ease and each end is exactly the type
    // it hands over to.
    let stripType = TextSize.lg / TextSize.xs
    return ZStack {
      Text(text)
        .font(.sans(TextSize.xs, .medium))
        .foregroundStyle(monthColor)
        .scaleEffect(follows ? stripType : 1)
        .opacity(follows ? 0 : 1)
      if focused {
        Text(text)
          .font(.sans(TextSize.lg, .semibold))
          .foregroundStyle(today ? Palette.primaryForeground : Palette.foreground)
          .scaleEffect(follows ? 1 : 1 / stripType)
          .opacity(follows ? 1 : 0)
      }
    }
    .frame(width: follows ? M.stripNumberSize : M.numberSize, height: follows ? M.stripNumberSize : M.numberSize)
    .background { if today { Circle().fill(Palette.primary) } }
    .matchedGeometryEffect(
      id: follows ? ZoomID.date(day, zone: navigation.zone) : "month-\(ZoomID.date(day, zone: navigation.zone))",
      in: zoom,
      isSource: false
    )
  }
}

/// A day cell's chips and "+N more", as many as fit.
private struct MonthCellEvents: View, Equatable {
  let events: [CalendarEvent]
  let eventArea: CGFloat
  let data: CalendarData

  private typealias M = MonthGrid

  nonisolated static func == (a: Self, b: Self) -> Bool {
    a.events == b.events && a.eventArea == b.eventArea
  }

  var body: some View {
    let fit = M.visibleEvents(count: events.count, availableHeight: eventArea)
    VStack(alignment: .leading, spacing: M.rowGap) {
      Color.clear.frame(width: M.numberSize, height: M.numberSize)
      ForEach(events.prefix(fit.visible)) { event in
        MonthChip(event: event, hue: Palette.event(data.colorKey(for: event)))
          .frame(height: M.rowHeight)
      }
      if fit.hidden > 0 {
        Text("+\(fit.hidden) more")
          .font(.sans(10))
          .foregroundStyle(Palette.mutedForeground)
          .padding(.horizontal, 4)
          .frame(height: M.rowHeight)
      }
    }
  }
}

/// Events bucketed by day, kept until the events, days or zone change.
private final class MonthBuckets {
  private var events: [CalendarEvent]?
  private var days: [Date] = []
  private var zone: WorkingZone?
  private var result: [Date: [CalendarEvent]] = [:]

  func get(_ events: [CalendarEvent], days: [Date], zone: WorkingZone) -> [Date: [CalendarEvent]] {
    if events == self.events, days == self.days, zone == self.zone { return result }
    result = MonthGrid.bucket(events, days: days, zone: zone)
    self.events = events
    self.days = days
    self.zone = zone
    return result
  }
}
