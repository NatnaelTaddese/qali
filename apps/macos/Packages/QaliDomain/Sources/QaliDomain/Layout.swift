import Foundation

// Port of packages/domain/src/calendar/layout.ts.

/// Smallest per-hour height before the grid stops compressing and scrolls.
public let minHourHeight: Double = 40
public let minDayHeight: Double = 24 * minHourHeight

/// Split a page's events into its all-day band and per-day timed columns.
/// Events from the wider buffered window are filtered down to `days` here.
/// `days` are working-zone midnights, ascending.
public func bucketDayEvents<E: CalendarEventLike>(
  days: [Date],
  events: [E]
) -> (allDayEvents: [E], timedByDay: [[E]]) {
  let dayStarts = days.map(\.ms)
  var timedByDay: [[E]] = days.map { _ in [] }
  guard let rangeStartMs = dayStarts.first, let rangeLastMs = dayStarts.last else {
    return ([], timedByDay)
  }
  let rangeEndMs = rangeLastMs + msPerDay
  var allDayEvents: [E] = []
  for event in events {
    if event.allDay {
      if event.endMs > rangeStartMs && event.startMs < rangeEndMs {
        allDayEvents.append(event)
      }
      continue
    }
    for (i, dayStartMs) in dayStarts.enumerated() {
      // Days ascend, so once one starts at or after the event's end, no later
      // day can overlap it either.
      if dayStartMs >= event.endMs { break }
      if dayStartMs + msPerDay <= event.startMs { continue }
      timedByDay[i].append(event)
    }
  }
  allDayEvents = stableSorted(allDayEvents) { $0.startMs < $1.startMs }
  return (allDayEvents, timedByDay)
}

/// Snap a pointer offset within a measured day column to the nearest
/// 15-minute mark.
public func snappedMsFromOffsetY(_ offsetY: Double, dayStartMs: Double, dayHeight: Double) -> Double {
  let steps = jsRound(offsetY / dayHeight * (24 * 60 / snapMinutes))
  let ms = dayStartMs + steps * snapMs
  return min(max(ms, dayStartMs), dayStartMs + msPerDay)
}

/// The first `durationMs` slot on `dayStartMs` that no timed event overlaps.
///
/// Search begins at 9:00 AM, or — when the day is today and it's already
/// later — at the next snap boundary from `nowMs`. Slots step by `snapMs`. If
/// the day fills up, the last snap boundary that still fits before midnight is
/// returned, so a range always comes back. All-day events are ignored.
public func nextFreeSlot<E: CalendarEventLike>(
  dayStartMs: Double,
  events: [E],
  nowMs: Double,
  durationMs: Double = defaultEventDurationMs
) -> (startMs: Double, endMs: Double) {
  let nineAmMs = dayStartMs + defaultEventStartMinutes * msPerMinute
  let isToday = nowMs >= dayStartMs && nowMs < dayStartMs + msPerDay
  let fromNowMs = (nowMs / snapMs).rounded(.up) * snapMs
  var startMs = isToday ? max(nineAmMs, fromNowMs) : nineAmMs
  let lastStartMs = dayStartMs + msPerDay - durationMs

  let timed = stableSorted(events.filter { !$0.allDay }) { $0.startMs < $1.startMs }

  while startMs <= lastStartMs {
    let endMs = startMs + durationMs
    guard let clash = timed.first(where: { $0.startMs < endMs && $0.endMs > startMs }) else {
      return (startMs, endMs)
    }
    // Jump past the blocking event, snapped forward, rather than crawling by
    // one slot through a long meeting.
    startMs = max(startMs + snapMs, (clash.endMs / snapMs).rounded(.up) * snapMs)
  }

  // Day is full: fall back to the last slot that fits before midnight.
  return (lastStartMs, lastStartMs + durationMs)
}

/// A timed event placed in its day column.
public struct PositionedEvent<E: CalendarEventLike> {
  public var event: E
  /// 0–100, distance from the top of the day.
  public var topPct: Double
  /// 0–100, share of the day height.
  public var heightPct: Double
  /// Cascade depth: how many earlier events in the cluster are still running
  /// at this event's start. Drives the horizontal indent only.
  public var stackIndex: Int
  /// Number of cards in this event's overlap cluster (1 when alone).
  public var stackCount: Int
  /// Paint order within the cluster (0 = earliest start); higher sits on top.
  public var elevation: Int
  /// Lane this event occupies in side-by-side layout. 0 is leftmost.
  public var columnIndex: Int
  /// Number of lanes the event's cluster splits into (1 when alone).
  public var columnCount: Int
  /// Lanes the card fills once it expands right into free space (>= 1).
  public var columnSpan: Int
  /// Fraction of a card's width the next lane advances by: `laneAdvanceRatio`
  /// for the overlapping fan, or 1 when the cluster tiles into clean columns.
  public var laneAdvance: Double
}

/// Blank strip reserved on the left edge of every day column.
public let eventLeftGutter: Double = 12

/// Horizontal shift per stack level in the overlap cascade.
public let stackIndentStep: Double = 14
/// Stack levels that get the full indent before it stops growing.
let stackMaxLevels = 3
/// Thin residual indent per level past the cap, so deep cards still peek out.
let stackDeepStep: Double = 4

/// Left indent for a card at `stackIndex`, capped so front cards stay wide in
/// deep overlaps while every card behind still exposes a sliver.
public func stackIndent(_ stackIndex: Int) -> Double {
  let capped = min(stackIndex, stackMaxLevels)
  let overflow = max(0, stackIndex - stackMaxLevels)
  return Double(capped) * stackIndentStep + Double(overflow) * stackDeepStep
}

/// How far the next overlapping card advances past the previous one, as a
/// fraction of a card's width.
public let laneAdvanceRatio = 0.62

/// When two overlapping cards start within this window, the cluster tiles into
/// clean, equal columns so neither header is covered.
public let laneTileMaxStaggerMs: Double = 30 * msPerMinute

/// Week-view counterpart of `laneTileMaxStaggerMs`: narrower columns tile more
/// eagerly. The Expo 3-day strip uses this one.
public let weekLaneTileMaxStaggerMs: Double = 45 * msPerMinute

/// Horizontal box (`left`/`width` as 0–1 fractions of the column) for an event
/// in side-by-side lanes. Cards fan left to right overlapping by `1 - advance`
/// of their width; at `advance` 1 they tile into clean, equal columns.
public func laneBox(
  columnIndex: Int,
  columnCount: Int,
  columnSpan: Int,
  advance: Double = laneAdvanceRatio
) -> (left: Double, width: Double) {
  guard columnCount > 1 else { return (0, 1) }
  // Width W and step S solve (n-1)·S + W = 1 with S = advance·W, so the fan
  // exactly spans the column and the rightmost card ends flush.
  let width = 1 / (1 + Double(columnCount - 1) * advance)
  let step = advance * width
  return (Double(columnIndex) * step, width + Double(columnSpan - 1) * step)
}

/// Position a day's timed events: clamp to the day, then cascade transitively
/// overlapping events. Each event indents past the earlier events still
/// running at its start and paints in start order.
public func layoutDayEvents<E: CalendarEventLike>(
  _ events: [E],
  dayStartMs: Double,
  tileMaxStaggerMs: Double = laneTileMaxStaggerMs
) -> [PositionedEvent<E>] {
  let dayEndMs = dayStartMs + msPerDay
  let clamped = events.map { event -> LayoutItem<E> in
    let start = max(event.startMs, dayStartMs)
    let end = min(max(event.endMs, start + snapMs), dayEndMs)
    return LayoutItem(event: event, start: start, end: end)
  }
  // Start order; on a tie the longer event first.
  var items = stableSorted(clamped) { (a: LayoutItem<E>, b: LayoutItem<E>) -> Bool in
    if a.start != b.start { return a.start < b.start }
    return a.end - a.start > b.end - b.start
  }

  // Walk events in start order, grouping transitively overlapping ones into
  // clusters; each cluster is laid out independently. Clusters are ranges of
  // `items` indices.
  var clusterStart = 0
  var clusterEnd = -Double.infinity

  func closeCluster(upTo end: Int) {
    let range = clusterStart..<end
    guard !range.isEmpty else { return }
    for i in range { items[i].stackCount = range.count }

    // Column packing: greedy first-fit into lanes.
    var laneEnds: [Double] = []
    for i in range {
      let lane = laneEnds.firstIndex { $0 <= items[i].start } ?? laneEnds.count
      if lane == laneEnds.count { laneEnds.append(items[i].end) } else { laneEnds[lane] = items[i].end }
      items[i].columnIndex = lane
    }
    let columnCount = laneEnds.count
    // Expand each card right into free lanes: stop at the first later-lane
    // event it overlaps in time.
    for i in range {
      items[i].columnCount = columnCount
      var span = columnCount - items[i].columnIndex
      for j in range where j != i && items[j].columnIndex > items[i].columnIndex {
        if items[j].start < items[i].end && items[j].end > items[i].start {
          span = min(span, items[j].columnIndex - items[i].columnIndex)
        }
      }
      items[i].columnSpan = max(span, 1)
    }

    // Tile the whole cluster when any overlapping pair starts too close for
    // the fan to keep both headers readable.
    var tiled = false
    outer: for i in range {
      for j in range where j > i {
        let a = items[i], b = items[j]
        if a.start < b.end && b.start < a.end && abs(a.start - b.start) < tileMaxStaggerMs {
          tiled = true
          break outer
        }
      }
    }
    for i in range { items[i].laneAdvance = tiled ? 1 : laneAdvanceRatio }
    clusterStart = end
  }

  for index in items.indices {
    if items[index].start >= clusterEnd { closeCluster(upTo: index) }
    let item = items[index]
    // Indent past every earlier cluster member still running at our start.
    items[index].stackIndex = items[clusterStart..<index].filter { $0.end > item.start }.count
    // Paint order: later starts sit on top of earlier ones in the cluster.
    items[index].elevation = index - clusterStart
    clusterEnd = max(clusterEnd, item.end)
  }
  closeCluster(upTo: items.count)

  return items.map { item in
    PositionedEvent(
      event: item.event,
      topPct: msToPct(item.start, dayStartMs: dayStartMs),
      heightPct: msToPct(item.end, dayStartMs: dayStartMs) - msToPct(item.start, dayStartMs: dayStartMs),
      stackIndex: item.stackIndex,
      stackCount: item.stackCount,
      elevation: item.elevation,
      columnIndex: item.columnIndex,
      columnCount: item.columnCount,
      columnSpan: item.columnSpan,
      laneAdvance: item.laneAdvance
    )
  }
}

/// Working state for one event while `layoutDayEvents` packs its cluster.
private struct LayoutItem<E: CalendarEventLike> {
  var event: E
  var start: Double
  var end: Double
  var stackIndex = 0
  var stackCount = 1
  var elevation = 0
  var columnIndex = 0
  var columnCount = 1
  var columnSpan = 1
  var laneAdvance = laneAdvanceRatio
}

// MARK: - JavaScript parity helpers

/// `Array.prototype.sort` is stable; Swift's `sort` doesn't promise to be.
func stableSorted<T>(_ values: [T], by areInIncreasingOrder: (T, T) -> Bool) -> [T] {
  values.enumerated()
    .sorted { a, b in
      if areInIncreasingOrder(a.element, b.element) { return true }
      if areInIncreasingOrder(b.element, a.element) { return false }
      return a.offset < b.offset
    }
    .map(\.element)
}

/// `Math.round`: halves round toward +∞.
func jsRound(_ value: Double) -> Double {
  (value + 0.5).rounded(.down)
}
