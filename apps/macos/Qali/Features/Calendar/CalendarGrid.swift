import QaliDomain
import SwiftUI

/// The calendar under the toolbar: the time grid (day and week) and the month
/// grid, with the page's events.
///
/// Both grids are always in place, one of them invisible, because switching
/// between them is a zoom and not a swap. The month is the week zoomed out:
/// going to Month, the time grid closes down onto the rectangle its page
/// occupies in the month while that week's row shrinks from the whole grid to
/// its place and the other weeks open up above and below it. Going back, the
/// row grows to fill the grid again. Day and Week are the same time grid at
/// different widths, so that switch only moves its columns.
struct CalendarGrid: View {
  let navigation: CalendarNavigation
  let data: CalendarData

  @Namespace private var zoom

  var body: some View {
    // Read the view and both pages together and hand them down as values, so
    // neither grid can be re-evaluated against the other's page.
    let isMonth = navigation.view == .month
    let stripDays = navigation.stripDays
    let monthDays = navigation.monthDays
    GeometryReader { proxy in
      let layout = MonthZoomLayout(
        size: proxy.size,
        days: monthDays,
        focus: stripDays,
        expanded: !isMonth,
        zone: navigation.zone
      )
      // The rectangle the time grid fills: all of it, or (zoomed out) its
      // own page's place in the month. It is scaled into it rather than
      // cropped, so the week shrinks into its row and the day into its cell
      // as the month opens around them.
      let full = CGRect(origin: .zero, size: proxy.size)
      let target = isMonth ? layout.focusRect : full
      let fade = CalendarNavigation.zoomDuration
      ZStack(alignment: .topLeading) {
        // A header band that never moves or fades, under both grids, easing
        // between the strip's height and the weekday row's. As the time
        // grid's header slides down into its row, the title bar still runs
        // straight into header colour instead of a white gap.
        HeaderBand {
          Color.clear.frame(height: layout.headerHeight)
        }

        // Skipped while its page is unchanged: scrolling the month rebuilds
        // this body every week, and the hidden time grid is costly to redo.
        StablePage(days: stripDays) {
          TimeGrid(days: stripDays, navigation: navigation, data: data, zoom: zoom)
        }
        .equatable()
          .scaleEffect(
            x: full.width > 0 ? target.width / full.width : 1,
            y: full.height > 0 ? target.height / full.height : 1,
            anchor: .topLeading
          )
          .offset(x: target.minX, y: target.minY)
          // Gone early on the way out, before it is small enough to read as
          // squashed. On the way in it is back at once, under the month,
          // which then fades off it, so nothing between them goes blank.
          .animation(isMonth ? .easeOut(duration: fade * 0.35) : .easeOut(duration: fade * 0.2)) {
            $0.opacity(isMonth ? 0 : 1)
          }
          .allowsHitTesting(!isMonth)
          .accessibilityHidden(isMonth)

        MonthGrid(
          days: monthDays,
          bufferDays: navigation.monthBufferDays,
          layout: layout,
          navigation: navigation,
          data: data,
          zoom: zoom,
          shown: isMonth
        )
        // Skipped while its inputs are unchanged: this body re-renders as
        // the month scrolls (the month in view, the held page), and the
        // grid redoes only what it observes itself.
        .equatable()
          .allowsHitTesting(isMonth)
          .accessibilityHidden(!isMonth)
      }
    }
    // Not into the top safe area: a shape-style background fills every edge
    // by default and would cover the header colour behind the toolbar.
    .background(Palette.background, ignoresSafeAreaEdges: [.horizontal, .bottom])
    // The header colour behind the toolbar. It lives here, outside the grids,
    // so the time grid's mask cannot cut it off.
    .background(alignment: .top) {
      Palette.calendarHeader
        .ignoresSafeArea(edges: .top)
        .frame(height: 1)
    }
  }
}

/// Web grid metrics (components/calendar/lib.ts).
nonisolated enum GridMetrics {
  static let gutter: CGFloat = 64
  static let headerHeight: CGFloat = 44
  static let minHourHeight: CGFloat = 40
  /// Scroll room below midnight, where the day dividers fade out
  /// (`TIME_GRID_BOTTOM_SPACER_HEIGHT`).
  static let bottomRunout: CGFloat = 96
  /// How far the day dividers run on above the hour grid's top, for an
  /// overscroll to reveal: more than any rubber-band pull can travel.
  static let overscrollRoom: CGFloat = 1200
  /// How far down the header the day dividers take to fade in.
  static let headerDividerFade: CGFloat = 32
  /// The month view's weekday row.
  static let monthHeaderHeight: CGFloat = 32
}

/// Identities shared between the two grids, for the pieces that travel from
/// one to the other.
enum ZoomID {
  static func date(_ day: Date, zone: WorkingZone) -> String {
    "date-\(dayKey(day, zone: zone))"
  }

  static func weekday(_ day: Date, zone: WorkingZone) -> String {
    "weekday-\(dayKey(day, zone: zone))"
  }
}

/// Where the month grid's rows and columns sit, resting or zoomed.
///
/// Resting (`expanded` false) it is the plain month: equal columns across the
/// whole width and equal rows under the weekday header. Expanded, it takes the
/// time grid's shape: the header is the day strip's height, the columns start
/// after the time gutter, the focused week's row is the whole body and the
/// other rows have no height. When the focus is a single day, its column is
/// likewise the whole width. SwiftUI animates each frame between the two, and
/// since every edge moves linearly the rows stay flush on the way.
struct MonthZoomLayout: Equatable {
  let size: CGSize
  let rows: Int
  /// The week row holding the time grid's page.
  let focusRow: Int
  /// The day's column when the time grid shows a single day.
  let focusColumn: Int?
  let expanded: Bool

  init(size: CGSize, days: [Date], focus: [Date], expanded: Bool, zone: WorkingZone) {
    self.size = size
    self.expanded = expanded
    rows = max(days.count / 7, 1)
    let index = focus.first.flatMap { first in days.firstIndex { zone.isSameDay($0, first) } } ?? 0
    focusRow = min(index / 7, rows - 1)
    focusColumn = focus.count == 1 ? index % 7 : nil
  }

  var headerHeight: CGFloat {
    expanded ? GridMetrics.headerHeight : GridMetrics.monthHeaderHeight
  }

  var bodyHeight: CGFloat { max(size.height - headerHeight, 0) }

  private var leading: CGFloat { expanded ? GridMetrics.gutter : 0 }

  func width(column: Int) -> CGFloat {
    guard expanded else { return size.width / 7 }
    let available = max(size.width - GridMetrics.gutter, 0)
    guard let focusColumn else { return available / 7 }
    return column == focusColumn ? available : 0
  }

  func x(column: Int) -> CGFloat {
    leading + (0..<column).reduce(0) { $0 + width(column: $1) }
  }

  func height(row: Int) -> CGFloat {
    guard expanded else { return bodyHeight / CGFloat(rows) }
    return row == focusRow ? bodyHeight : 0
  }

  /// A row's top; rows above the first (a scroll's buffer) sit above zero.
  func y(row: Int) -> CGFloat {
    row >= 0
      ? (0..<row).reduce(0) { $0 + height(row: $1) }
      : -(row..<0).reduce(0) { $0 + height(row: $1) }
  }

  /// A cell's height in the resting month, whatever the zoom: what fits in a
  /// cell is decided once, so its events do not reflow while it changes size.
  var restingCellWidth: CGFloat { size.width / 7 }

  var restingCellHeight: CGFloat {
    max(size.height - GridMetrics.monthHeaderHeight, 0) / CGFloat(rows)
  }

  /// The time grid's page in the resting month: its week's row, or its day's
  /// cell.
  var focusRect: CGRect {
    let column = size.width / 7
    return CGRect(
      x: focusColumn.map { CGFloat($0) * column } ?? 0,
      y: GridMetrics.monthHeaderHeight + CGFloat(focusRow) * restingCellHeight,
      width: focusColumn == nil ? size.width : column,
      height: restingCellHeight
    )
  }
}

/// The header band: the calendar-header colour over a hairline.
struct HeaderBand<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    content
      .background(Palette.calendarHeader)
      .overlay(alignment: .bottom) { Palette.border.frame(height: 1) }
  }
}

/// The calendar's event fill: the event's hue mixed into the card colour
/// (`color-mix(in oklab, var(--event-n) 22%, var(--card))` on the web).
struct EventTint: View {
  let hue: Color
  var strength = 0.22

  var body: some View {
    ZStack {
      Palette.card
      hue.opacity(strength)
    }
  }
}

extension CalendarEvent {
  var title: String { summary ?? "(No title)" }
}

/// A view that SwiftUI skips re-evaluating while `days` is unchanged. What
/// the content observes itself (events, the zone) still updates it.
struct StablePage<Content: View>: View, Equatable {
  let days: [Date]
  @ViewBuilder var content: () -> Content

  var body: some View { content() }

  static func == (lhs: Self, rhs: Self) -> Bool { lhs.days == rhs.days }
}
