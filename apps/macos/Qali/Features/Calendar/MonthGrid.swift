import QaliDomain
import SwiftUI

/// The month view (the web's `MonthPanel`): weekday labels over a 6×7 grid of
/// day cells, each listing as many of its events as fit and counting the rest.
struct MonthGrid: View {
  let days: [Date]
  let navigation: CalendarNavigation
  let data: CalendarData

  /// Web metrics (MONTH_EVENT_ROW_HEIGHT / MONTH_EVENT_ROW_GAP).
  private static let rowHeight: CGFloat = 18
  private static let rowGap: CGFloat = 2
  /// The day number's row and the cell's padding around the events.
  private static let numberHeight: CGFloat = 24
  private static let padding: CGFloat = 4

  /// The page cut into weeks.
  private var weeks: [[Date]] {
    stride(from: 0, to: days.count, by: 7).map { Array(days[$0..<min($0 + 7, days.count)]) }
  }

  var body: some View {
    VStack(spacing: 0) {
      HeaderBand {
        HStack(spacing: 0) {
          ForEach(days.prefix(7), id: \.self) { day in
            Text(navigation.zone.format(day, "EEE").uppercased())
              .font(.sans(TextSize.xs, .medium))
              .tracking(0.3)
              .foregroundStyle(Palette.mutedForeground)
              .padding(.horizontal, 8)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .frame(height: 32)
      }
      GeometryReader { proxy in
        let cellHeight = proxy.size.height / CGFloat(max(weeks.count, 1))
        // What is left of a cell for events, under the day number.
        let eventArea = cellHeight - Self.padding * 2 - Self.numberHeight - Self.rowGap
        Grid(horizontalSpacing: 0, verticalSpacing: 0) {
          ForEach(weeks, id: \.first) { week in
            GridRow {
              ForEach(week, id: \.self) { day in
                cell(day, events: events(on: day), eventArea: eventArea)
              }
            }
          }
        }
      }
    }
  }

  private func cell(_ day: Date, events: [CalendarEvent], eventArea: CGFloat) -> some View {
    let today = navigation.isToday(day)
    let inMonth = navigation.zone.isSameMonth(day, navigation.anchor)
    let fit = Self.visibleEvents(count: events.count, availableHeight: eventArea)
    return VStack(alignment: .leading, spacing: Self.rowGap) {
      Text(navigation.zone.format(day, "d"))
        .font(.sans(TextSize.xs, .medium))
        .foregroundStyle(today ? Palette.primaryForeground : inMonth ? Palette.foreground : Palette.mutedForeground)
        .frame(width: Self.numberHeight, height: Self.numberHeight)
        .background { if today { Circle().fill(Palette.primary) } }
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
    .accessibilityElement(children: .contain)
    .accessibilityLabel(navigation.zone.format(day, "EEEE, MMMM d") + (today ? ", today" : ""))
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
  }
}
