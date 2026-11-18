import QaliDomain
import SwiftUI

/// The month view (the web's `MonthPanel`): weekday labels over a 6×7 grid of
/// day cells, each listing as many of its events as fit and counting the rest.
///
/// Its rows and columns are placed by a `MonthZoomLayout`, so the same grid
/// can open one week (or one day) out to the time grid's shape and close it
/// back; see `CalendarGrid`.
struct MonthGrid: View {
  let days: [Date]
  let layout: MonthZoomLayout
  let navigation: CalendarNavigation
  let data: CalendarData
  /// Shared with the time grid, whose day strip the focused dates start from.
  let zoom: Namespace.ID

  /// Web metrics (MONTH_EVENT_ROW_HEIGHT / MONTH_EVENT_ROW_GAP).
  private static let rowHeight: CGFloat = 18
  private static let rowGap: CGFloat = 2
  /// The day number's box and the cell's padding around its content.
  private static let numberSize: CGFloat = 24
  private static let padding: CGFloat = 4

  var body: some View {
    // What is left of a resting cell for events, under the day number.
    let eventArea = layout.restingCellHeight - Self.padding * 2 - Self.numberSize - Self.rowGap
    ZStack(alignment: .topLeading) {
      HeaderBand {
        Color.clear.frame(height: layout.headerHeight)
      }
      ForEach(Array(days.prefix(7).enumerated()), id: \.offset) { column, day in
        Text(navigation.zone.format(day, "EEE").uppercased())
          .font(.sans(TextSize.xs, .medium))
          .tracking(0.3)
          .foregroundStyle(Palette.mutedForeground)
          .fixedSize()
          .padding(.horizontal, 8)
          .frame(width: layout.width(column: column), height: layout.headerHeight, alignment: .leading)
          .clipped()
          .offset(x: layout.x(column: column))
      }
      ForEach(Array(days.enumerated()), id: \.element) { index, day in
        let row = index / 7
        let column = index % 7
        cell(day, events: events(on: day), eventArea: eventArea, focused: isFocused(row: row, column: column))
          .frame(width: layout.width(column: column), height: layout.height(row: row), alignment: .topLeading)
          .offset(x: layout.x(column: column), y: layout.headerHeight + layout.y(row: row))
      }
    }
    .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
    .clipped()
  }

  /// Whether the cell belongs to the time grid's page: its week, or its day.
  private func isFocused(row: Int, column: Int) -> Bool {
    row == layout.focusRow && (layout.focusColumn ?? column) == column
  }

  private func cell(_ day: Date, events: [CalendarEvent], eventArea: CGFloat, focused: Bool) -> some View {
    let today = navigation.isToday(day)
    let inMonth = days.count > 20 ? navigation.zone.isSameMonth(day, days[15]) : true
    let fit = Self.visibleEvents(count: events.count, availableHeight: eventArea)
    return ZStack(alignment: .topLeading) {
      VStack(alignment: .leading, spacing: Self.rowGap) {
        Color.clear.frame(width: Self.numberSize, height: Self.numberSize)
        ForEach(events.prefix(fit.visible)) { event in
          MonthChip(event: event, hue: Palette.event(data.colorKey(for: event)))
            .frame(height: Self.rowHeight)
        }
        if fit.hidden > 0 {
          Text("+\(fit.hidden) more")
            .font(.sans(10))
            .foregroundStyle(Palette.mutedForeground)
            .padding(.horizontal, 4)
            .frame(height: Self.rowHeight)
        }
      }
      .padding(Self.padding)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(inMonth ? Color.clear : Palette.muted.opacity(0.3))
      .overlay(alignment: .leading) { Palette.border.frame(width: 1) }
      .overlay(alignment: .bottom) { Palette.border.frame(height: 1) }
      .clipped()

      number(day, today: today, inMonth: inMonth, focused: focused)
        .padding(Self.padding)
    }
    // A squeezed-shut cell hides everything it holds, except in the focused
    // week, whose dates arrive from the day strip above the grid.
    // (A mask and not a conditional clip, so the cell keeps one identity.)
    .mask { Rectangle().padding(focused ? -4000 : 0) }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(navigation.zone.format(day, "EEEE, MMMM d") + (today ? ", today" : ""))
  }

  /// The day number. While the time grid is showing, the numbers of its page
  /// sit exactly on the day strip's own numbers; zooming out to the month
  /// lets go of them, and they glide down into their cells.
  private func number(_ day: Date, today: Bool, inMonth: Bool, focused: Bool) -> some View {
    let follows = layout.expanded && focused
    return Text(navigation.zone.format(day, "d"))
      .font(.sans(TextSize.xs, .medium))
      .foregroundStyle(today ? Palette.primaryForeground : inMonth ? Palette.foreground : Palette.mutedForeground)
      .frame(width: Self.numberSize, height: Self.numberSize)
      .background { if today { Circle().fill(Palette.primary) } }
      .matchedGeometryEffect(
        id: follows ? ZoomID.date(day, zone: navigation.zone) : "month-\(ZoomID.date(day, zone: navigation.zone))",
        in: zoom,
        isSource: false
      )
  }

  /// The day's events, all-day first and then by start.
  private func events(on day: Date) -> [CalendarEvent] {
    let zone = navigation.zone
    let dayStartMs = day.ms
    let dayEndMs = zone.addingDays(1, to: day).ms
    // All-day boundaries are UTC-midnight instants, so they are compared with
    // the cell's calendar date in UTC; a working-zone offset would spill a
    // single-day chip into the neighbouring cell.
    let parts = zone.calendar.dateComponents([.year, .month, .day], from: day)
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    let dayUtcMs = utc.date(from: parts)?.ms ?? dayStartMs
    return data.events
      .filter { event in
        event.allDay
          ? event.startMs <= dayUtcMs && dayUtcMs < event.endMs
          : event.startMs < dayEndMs && event.endMs > dayStartMs
      }
      .sorted { a, b in
        if a.allDay != b.allDay { return a.allDay }
        return a.startMs < b.startMs
      }
  }

  /// How many events fit, keeping the last row for the "+N more" count when
  /// they do not all fit (the web's `visibleMonthEventMetrics`).
  private static func visibleEvents(count: Int, availableHeight: CGFloat) -> (visible: Int, hidden: Int) {
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
