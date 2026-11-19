import Foundation

// Port of packages/domain/src/calendar/allday.ts.

/// Geometry for the all-day rail. The compact rail shows at most two lanes.
public let allDayCollapsedLanes = 2
public let allDayMaxExpandedLanes = 8
public let allDayEventHeight: Double = 20
public let allDayEventGap: Double = 4
public let allDayBandPadding: Double = 4

public func allDayBandHeight(laneCount: Int, expanded: Bool) -> Double {
  let visibleLanes =
    expanded
    ? min(max(laneCount, 1), allDayMaxExpandedLanes)
    : max(min(laneCount, allDayCollapsedLanes), 1)
  return allDayBandPadding * 2
    + Double(visibleLanes) * allDayEventHeight
    + Double(visibleLanes - 1) * allDayEventGap
}

/// Inclusive `(startIdx, endIdx)` day columns an all-day event covers within
/// `days`, clamped to the range. All-day boundaries are UTC-midnight instants
/// (Google date-only), so indices are derived in UTC from the first day's
/// working-zone calendar date — a zone-local day diff would shift events by
/// the UTC offset.
public func allDayColumnSpan(
  startMs: Double,
  endMs: Double,
  days: [Date],
  zone: WorkingZone
) -> (startIdx: Int, endIdx: Int) {
  guard let first = days.first else { return (0, 0) }
  let parts = zone.calendar.dateComponents([.year, .month, .day], from: first)
  var utc = Calendar(identifier: .gregorian)
  utc.timeZone = TimeZone(identifier: "UTC")!
  let base = utc.date(from: DateComponents(year: parts.year, month: parts.month, day: parts.day))!.ms
  let lastIdx = days.count - 1
  let startIdx = Int(jsRound((startMs - base) / msPerDay))
  // endMs is the exclusive UTC midnight after the last day; step back to the
  // last day the event actually occupies.
  let endIdx = Int(jsRound((endMs - msPerDay - base) / msPerDay))
  return (max(startIdx, 0), min(max(endIdx, startIdx), lastIdx))
}

public struct AllDayEventLayout<E: CalendarEventLike> {
  public var event: E
  public var startIdx: Int
  public var endIdx: Int
  public var lane: Int
}

/// Pack spanning all-day events into the first free non-overlapping lane.
///
/// Lanes are packed over the whole buffered `days` window, so a card keeps the
/// same lane wherever the strip is scrolled; the returned spans are then
/// clamped to the visible range, so only their width changes.
public func layoutAllDayEvents<E: CalendarEventLike>(
  days: [Date],
  events: [E],
  zone: WorkingZone,
  visibleStartIdx: Int = 0,
  visibleEndIdx: Int? = nil
) -> [AllDayEventLayout<E>] {
  let visibleEndIdx = visibleEndIdx ?? days.count - 1
  let spans = stableSorted(
    events.map { event in
      let span = allDayColumnSpan(startMs: event.startMs, endMs: event.endMs, days: days, zone: zone)
      return AllDayEventLayout(event: event, startIdx: span.startIdx, endIdx: span.endIdx, lane: 0)
    }
  ) { a, b in
    // A fixed global lane priority: earlier start, then longer, then start
    // instant, then id — identical for every scroll position.
    if a.startIdx != b.startIdx { return a.startIdx < b.startIdx }
    if a.endIdx != b.endIdx { return a.endIdx > b.endIdx }
    if a.event.startMs != b.event.startMs { return a.event.startMs < b.event.startMs }
    return a.event.id < b.event.id
  }

  var laneEnds: [Int] = []
  return spans
    .map { span in
      var span = span
      let lane = laneEnds.firstIndex { $0 < span.startIdx } ?? laneEnds.count
      if lane == laneEnds.count { laneEnds.append(span.endIdx) } else { laneEnds[lane] = span.endIdx }
      span.lane = lane
      return span
    }
    .filter { $0.endIdx >= visibleStartIdx && $0.startIdx <= visibleEndIdx }
    .map { entry in
      var entry = entry
      entry.startIdx = max(entry.startIdx, visibleStartIdx)
      entry.endIdx = min(entry.endIdx, visibleEndIdx)
      return entry
    }
}

public func visibleAllDayMetrics<E>(
  _ events: [AllDayEventLayout<E>],
  visibleStartIdx: Int,
  visibleEndIdx: Int
) -> (laneCount: Int, hiddenEventCount: Int) {
  var laneCount = 0
  var hiddenEventCount = 0
  for event in events where !(event.endIdx < visibleStartIdx || event.startIdx > visibleEndIdx) {
    laneCount = max(laneCount, event.lane + 1)
    if event.lane >= allDayCollapsedLanes { hiddenEventCount += 1 }
  }
  return (laneCount, hiddenEventCount)
}
