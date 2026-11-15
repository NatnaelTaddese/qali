import QaliDomain
import SwiftUI

/// The day and week views: a date row and an all-day band over a scrolling
/// 24-hour grid, with each day's timed events laid out by QaliDomain (the
/// same cascade and lane rules as the web's `layoutDayEvents`).
struct TimeGrid: View {
  let days: [Date]
  let navigation: CalendarNavigation
  let data: CalendarData

  /// The page whose all-day band is expanded; paging away collapses it.
  @State private var expandedPage: Date?
  @State private var scroll = ScrollPosition(edge: .top)

  var body: some View {
    let buckets = bucketDayEvents(days: days, events: data.events)
    let allDay = layoutAllDayEvents(days: days, events: buckets.allDayEvents, zone: navigation.zone)
    let metrics = visibleAllDayMetrics(allDay, visibleStartIdx: 0, visibleEndIdx: days.count - 1)
    let expanded = expandedPage == navigation.anchor
    let bandHeight = metrics.laneCount == 0 ? 0 : allDayBandHeight(laneCount: metrics.laneCount, expanded: expanded)

    VStack(spacing: 0) {
      HeaderBand {
        VStack(spacing: 0) {
          HStack(spacing: 0) {
            Color.clear.frame(width: GridMetrics.gutter)
            ForEach(days, id: \.self) { day in
              DayHeader(day: day, navigation: navigation)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
          .frame(height: GridMetrics.headerHeight)

          AllDayBand(
            layouts: allDay,
            dayCount: days.count,
            hiddenCount: metrics.hiddenEventCount,
            expanded: expanded,
            data: data
          ) {
            withAnimation(.snappy(duration: 0.2)) {
              expandedPage = expanded ? nil : navigation.anchor
            }
          }
          .frame(height: bandHeight)
          .clipped()
        }
      }
      .animation(.snappy(duration: 0.2), value: bandHeight)

      GeometryReader { proxy in
        // The day fills the window when there is room, and scrolls otherwise.
        let hour = max(GridMetrics.minHourHeight, proxy.size.height / 24)
        ScrollView {
          ZStack(alignment: .topLeading) {
            GridLines(columns: days.count, hour: hour)
            HourLabels(hour: hour, use24h: navigation.use24h)
            TimedEvents(days: days, timedByDay: buckets.timedByDay, navigation: navigation, data: data)
            NowLine(days: days, navigation: navigation, hour: hour)
          }
          .frame(height: hour * 24)
        }
        .scrollPosition($scroll)
        .onAppear {
          // Open with the current time in the middle of the window, as far as
          // the day's ends allow.
          let now = Date.now.timeIntervalSince(navigation.zone.startOfDay(.now)) / 3600
          let limit = max(hour * 24 - proxy.size.height, 0)
          scroll.scrollTo(y: min(max(now * hour - proxy.size.height / 2, 0), limit))
        }
      }
    }
  }
}

// MARK: - Header

private struct DayHeader: View {
  let day: Date
  let navigation: CalendarNavigation

  var body: some View {
    let today = navigation.isToday(day)
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(navigation.zone.format(day, "EEE").uppercased())
        .font(.sans(TextSize.xs, .medium))
        .tracking(0.3)
        .foregroundStyle(today ? Palette.foreground : Palette.mutedForeground)
      Text(navigation.zone.format(day, "d"))
        .font(.sans(TextSize.lg, .semibold))
        .foregroundStyle(today ? Palette.primaryForeground : Palette.foreground)
        .frame(minWidth: 28, minHeight: 28)
        .background { if today { Circle().fill(Palette.primary) } }
    }
    .padding(.horizontal, 8)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(navigation.zone.format(day, "EEEE, MMMM d") + (today ? ", today" : ""))
  }
}

/// All-day and multi-day events, packed into lanes across the day columns.
/// Two lanes show by default; the gutter control reveals the rest.
private struct AllDayBand: View {
  let layouts: [AllDayEventLayout<CalendarEvent>]
  let dayCount: Int
  let hiddenCount: Int
  let expanded: Bool
  let data: CalendarData
  let toggle: () -> Void

  var body: some View {
    GeometryReader { proxy in
      let column = (proxy.size.width - GridMetrics.gutter) / CGFloat(max(dayCount, 1))
      ZStack(alignment: .topLeading) {
        ForEach(layouts, id: \.event.id) { layout in
          if expanded || layout.lane < allDayCollapsedLanes {
            AllDayCard(event: layout.event, hue: Palette.event(data.colorKey(for: layout.event)))
              .frame(
                width: max(column * CGFloat(layout.endIdx - layout.startIdx + 1) - 8, 0),
                height: allDayEventHeight
              )
              .offset(
                x: GridMetrics.gutter + column * CGFloat(layout.startIdx) + 4,
                y: allDayBandPadding + Double(layout.lane) * (allDayEventHeight + allDayEventGap)
              )
          }
        }
        if hiddenCount > 0 || expanded {
          Button(action: toggle) {
            HStack(spacing: 2) {
              if !expanded { Text("+\(hiddenCount)") }
              Image(systemName: expanded ? "chevron.up" : "chevron.down")
                .font(.system(size: 8, weight: .bold))
            }
            .font(.sans(TextSize.xs, .medium))
            .foregroundStyle(Palette.mutedForeground)
            .frame(width: GridMetrics.gutter - 10, height: allDayEventHeight, alignment: .trailing)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .offset(y: allDayBandPadding)
          .accessibilityLabel(expanded ? "Show fewer all-day events" : "Show \(hiddenCount) more all-day events")
        }
      }
    }
  }
}

private struct AllDayCard: View {
  let event: CalendarEvent
  let hue: Color

  private let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)

  var body: some View {
    Text(event.title)
      .font(.sans(TextSize.xs, .medium))
      .lineLimit(1)
      .padding(.leading, 11)
      .padding(.trailing, 8)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      .background { EventTint(hue: hue) }
      .overlay(alignment: .leading) {
        Capsule().fill(hue).frame(width: 3).padding(.vertical, 4).padding(.leading, 4)
      }
      .clipShape(shape)
      .overlay { shape.strokeBorder(Palette.border) }
      .help(event.title)
  }
}

// MARK: - Grid

/// Hour rows and day dividers, in the border colour.
private struct GridLines: View {
  let columns: Int
  let hour: CGFloat

  var body: some View {
    Canvas { context, size in
      var path = Path()
      for index in 1..<24 {
        let y = (CGFloat(index) * hour).rounded() + 0.5
        path.move(to: CGPoint(x: GridMetrics.gutter, y: y))
        path.addLine(to: CGPoint(x: size.width, y: y))
      }
      let column = (size.width - GridMetrics.gutter) / CGFloat(max(columns, 1))
      for index in 0..<columns {
        let x = (GridMetrics.gutter + CGFloat(index) * column).rounded() + 0.5
        path.move(to: CGPoint(x: x, y: 0))
        path.addLine(to: CGPoint(x: x, y: size.height))
      }
      context.stroke(path, with: .color(Palette.border), lineWidth: 1)
    }
    .accessibilityHidden(true)
  }
}

private struct HourLabels: View {
  let hour: CGFloat
  let use24h: Bool

  var body: some View {
    VStack(spacing: 0) {
      ForEach(0..<24, id: \.self) { index in
        Text(index == 0 ? "" : label(index))
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
          .frame(width: GridMetrics.gutter - 10, height: hour, alignment: .topTrailing)
          // Centre each label on its hour line.
          .offset(y: -7)
      }
    }
    .accessibilityHidden(true)
  }

  private func label(_ hour: Int) -> String {
    if use24h { return String(format: "%02d:00", hour) }
    return "\(hour % 12 == 0 ? 12 : hour % 12) \(hour < 12 ? "AM" : "PM")"
  }
}

/// The current time: a faint line across the page and a solid one, with its
/// dot, in today's column.
private struct NowLine: View {
  let days: [Date]
  let navigation: CalendarNavigation
  let hour: CGFloat

  var body: some View {
    if let index = days.firstIndex(where: navigation.isToday) {
      TimelineView(.periodic(from: .now, by: 30)) { timeline in
        GeometryReader { proxy in
          let start = navigation.zone.startOfDay(timeline.date)
          let y = timeline.date.timeIntervalSince(start) / 3600 * hour
          let column = (proxy.size.width - GridMetrics.gutter) / CGFloat(days.count)
          let x = GridMetrics.gutter + CGFloat(index) * column
          Rectangle()
            .fill(Color.red.opacity(0.25))
            .frame(width: proxy.size.width - GridMetrics.gutter, height: 1)
            .offset(x: GridMetrics.gutter, y: y)
          Rectangle()
            .fill(Color.red)
            .frame(width: column, height: 2)
            .offset(x: x, y: y - 1)
          Circle()
            .fill(Color.red)
            .frame(width: 8, height: 8)
            .offset(x: x - 4, y: y - 4)
        }
      }
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
  }
}

// MARK: - Timed events

/// Every day column's timed events, positioned inside the 24-hour body.
private struct TimedEvents: View {
  let days: [Date]
  let timedByDay: [[CalendarEvent]]
  let navigation: CalendarNavigation
  let data: CalendarData

  var body: some View {
    GeometryReader { proxy in
      let column = (proxy.size.width - GridMetrics.gutter) / CGFloat(max(days.count, 1))
      // Day view fans overlaps into lanes; week columns are too narrow to fan
      // and cascade instead, tiling only when starts are too close to stagger.
      let laneLayout = days.count == 1
      ForEach(Array(zip(days, timedByDay).enumerated()), id: \.element.0) { index, pair in
        let positioned = layoutDayEvents(
          pair.1,
          dayStartMs: pair.0.ms,
          tileMaxStaggerMs: laneLayout ? laneTileMaxStaggerMs : weekLaneTileMaxStaggerMs
        )
        ForEach(positioned, id: \.event.id) { item in
          let box = Self.box(for: item, column: column, dayHeight: proxy.size.height, laneLayout: laneLayout)
          EventCard(
            event: item.event,
            hue: Palette.event(data.colorKey(for: item.event)),
            time: timeText(item.event),
            size: box.size
          )
          .frame(width: box.width, height: box.height)
          .offset(x: GridMetrics.gutter + CGFloat(index) * column + box.minX, y: box.minY)
          .zIndex(Double(10 + item.elevation))
        }
      }
    }
  }

  /// The card's frame inside its day column (the web's `EventCard` geometry).
  private static func box(
    for item: PositionedEvent<CalendarEvent>,
    column: CGFloat,
    dayHeight: CGFloat,
    laneLayout: Bool
  ) -> CGRect {
    // A strip on the left of every column stays free, so there is always
    // somewhere to click to start a new event beside an existing one.
    let available = column - eventLeftGutter
    let x: CGFloat
    let width: CGFloat
    if laneLayout || item.laneAdvance == 1 {
      let lane = laneBox(
        columnIndex: item.columnIndex,
        columnCount: item.columnCount,
        columnSpan: item.columnSpan,
        advance: item.laneAdvance
      )
      x = eventLeftGutter + lane.left * available + 2
      width = lane.width * available - 4
    } else {
      let indent = stackIndent(item.stackIndex)
      x = eventLeftGutter + indent + 2
      width = available - indent - 4
    }
    return CGRect(
      x: x,
      y: item.topPct / 100 * dayHeight,
      width: max(width, 0),
      // Short events are drawn a little taller than their true length so the
      // title still reads, the trade every calendar makes.
      height: max(item.heightPct / 100 * dayHeight, 20)
    )
  }

  private func timeText(_ event: CalendarEvent) -> String {
    let zone = navigation.zone
    let start = zone.format(Date(ms: event.startMs), timePattern(use24h: navigation.use24h, withDayPeriod: false))
    let end = zone.format(Date(ms: event.endMs), timePattern(use24h: navigation.use24h))
    return "\(start) – \(end)"
  }
}

/// A timed event on the grid: tinted fill, the 3pt colour rail, title and
/// time. Like the web card, it sheds detail as it gets shorter: two title
/// lines, then one, then the title alone in small type.
private struct EventCard: View {
  let event: CalendarEvent
  let hue: Color
  let time: String
  let size: CGSize

  private let shape = RoundedRectangle(cornerRadius: 9, style: .continuous)

  var body: some View {
    let height = size.height
    let compact = height <= 38
    VStack(alignment: .leading, spacing: 0) {
      Text(event.title)
        .font(.sans(compact ? TextSize.xs : TextSize.sm, .medium))
        // A second line only where it can break between words: in a narrow
        // tiled card it would split a word in the middle.
        .lineLimit(height > 52 && size.width >= 110 ? 2 : 1)
      if !compact {
        Text(time)
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
          .lineLimit(1)
      }
      if height >= 80, event.conferenceUrl != nil {
        Spacer(minLength: 0)
        Image(systemName: "video")
          .font(.system(size: 11))
          .foregroundStyle(Palette.mutedForeground.opacity(0.6))
          .frame(maxWidth: .infinity, alignment: .trailing)
          .accessibilityLabel("Video call attached")
      }
    }
    .padding(.leading, 12)
    .padding(.trailing, 8)
    .padding(.vertical, compact ? 0 : 4)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: compact ? .leading : .topLeading)
    .background { EventTint(hue: hue) }
    .overlay(alignment: .leading) {
      Capsule().fill(hue).frame(width: 3).padding(.vertical, 4).padding(.leading, 4)
    }
    .clipShape(shape)
    .overlay { shape.strokeBorder(.primary.opacity(0.1)) }
    .shadow(color: .black.opacity(0.08), radius: 1.5, y: 1)
    .help("\(event.title)\n\(time)")
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(event.title), \(time)")
  }
}
