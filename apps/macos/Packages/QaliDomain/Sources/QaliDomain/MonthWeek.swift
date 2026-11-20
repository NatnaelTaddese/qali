import Foundation

// The month view's rows of events for one week (no web counterpart: the web
// month lists each day's events on its own). Multi-day all-day events become
// one bar across their days, as in the week view's all-day band; each week
// row lays out its own piece, so an event running past Sunday carries on as a
// new bar on the next row.

/// What a day cell draws on one of its event rows.
public enum MonthSlot<E> {
  /// Nothing: the row is free on this day, kept so the rows below line up.
  case empty
  /// The row is covered by a bar the week draws across its days.
  case bar
  /// A single-day chip: a timed event, or an all-day event of one day.
  case chip(E)
  /// The "+N more" count, in the last row that fits.
  case more(Int)
}

extension MonthSlot: Equatable where E: Equatable {}

/// One piece of a multi-day all-day event, across a run of the week's days
/// (`startIdx...endIdx`, 0 = the week's first day).
public struct MonthBar<E> {
  public var event: E
  public var lane: Int
  public var startIdx: Int
  public var endIdx: Int
  /// The event goes on before this piece: on the previous row, or hidden
  /// under the "+N more" of the day before.
  public var continuesBefore: Bool
  /// The event goes on after this piece, on the next row or under a count.
  public var continuesAfter: Bool
}

extension MonthBar: Equatable where E: Equatable {}

public struct MonthWeekLayout<E> {
  /// Per day of the week, its event rows from the top.
  public var days: [[MonthSlot<E>]]
  public var bars: [MonthBar<E>]
}

extension MonthWeekLayout: Equatable where E: Equatable {}

/// Lays out one week row of the month.
///
/// - `days`: the row's days, in order.
/// - `dayEvents`: each day's events (all-day ones included on every day they
///   cover), timed ones in start order.
/// - `rows`: how many event rows fit in a cell.
///
/// All-day events are packed into lanes shared by the whole row (the week
/// view's `layoutAllDayEvents`), so a bar keeps its height across the days it
/// covers. Each day's timed events then take its free rows from the top.
/// A day whose rows do not all fit keeps its last row for "+N more" and
/// counts what falls below; a bar is cut where it would be hidden, and its
/// visible runs are drawn as separate pieces.
public func layoutMonthWeek<E: CalendarEventLike>(
  days: [Date],
  dayEvents: [[E]],
  rows: Int,
  zone: WorkingZone
) -> MonthWeekLayout<E> {
  typealias Item = MonthItem<E>
  var seen = Set<String>()
  let allDayEvents = dayEvents.joined().filter { $0.allDay && seen.insert($0.id).inserted }
  let allDay = layoutAllDayEvents(days: days, events: allDayEvents, zone: zone)
  let raw = allDay.map { allDayRawSpan(startMs: $0.event.startMs, endMs: $0.event.endMs, days: days, zone: zone) }
  let multiDay = raw.map { $0.endIdx > $0.startIdx }

  var grid = [[Item?]](repeating: [], count: days.count)
  func place(_ item: Item, day: Int, lane: Int) {
    if grid[day].count <= lane { grid[day].append(contentsOf: repeatElement(nil, count: lane + 1 - grid[day].count)) }
    grid[day][lane] = item
  }
  for (index, entry) in allDay.enumerated() {
    for day in entry.startIdx...entry.endIdx {
      place(multiDay[index] ? .bar(index) : .chip(entry.event), day: day, lane: entry.lane)
    }
  }
  for (day, events) in dayEvents.enumerated() where day < days.count {
    for event in events where !event.allDay {
      let lane = grid[day].firstIndex { $0 == nil } ?? grid[day].count
      place(.chip(event), day: day, lane: lane)
    }
  }

  // Rows shown per day: all of them when they fit, else one fewer and a count.
  let limits = grid.map { $0.count <= rows ? $0.count : max(rows - 1, 0) }

  let slots = grid.enumerated().map { day, items -> [MonthSlot<E>] in
    let limit = limits[day]
    var slots: [MonthSlot<E>] = items.prefix(limit).map { item in
      switch item {
      case nil: .empty
      case .bar: .bar
      case .chip(let event): .chip(event)
      }
    }
    let hidden = items.dropFirst(limit).count(where: { $0 != nil })
    if hidden > 0 { slots.append(.more(hidden)) }
    return slots
  }

  var bars: [MonthBar<E>] = []
  for (index, entry) in allDay.enumerated() where multiDay[index] {
    var run: ClosedRange<Int>?
    func close() {
      guard let range = run else { return }
      bars.append(MonthBar(
        event: entry.event,
        lane: entry.lane,
        startIdx: range.lowerBound,
        endIdx: range.upperBound,
        continuesBefore: range.lowerBound > raw[index].startIdx,
        continuesAfter: range.upperBound < raw[index].endIdx
      ))
      run = nil
    }
    for day in entry.startIdx...entry.endIdx {
      if entry.lane < limits[day] {
        run = (run?.lowerBound ?? day)...day
      } else {
        close()
      }
    }
    close()
  }

  return MonthWeekLayout(days: slots, bars: bars)
}

/// What holds a day's row while a week is laid out.
private enum MonthItem<E> {
  /// Part of a multi-day all-day event; the index is into the packed lanes.
  case bar(Int)
  case chip(E)
}
