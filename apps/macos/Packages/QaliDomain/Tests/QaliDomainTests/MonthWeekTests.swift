import Foundation
import Testing
@testable import QaliDomain

@Suite struct LayoutMonthWeekTests {
  /// The week of Monday 5 Jan 2026 in `zone`.
  private func week(_ zone: WorkingZone) -> [Date] {
    (0..<7).map { midnight(2026, 1, 5 + $0, in: zone) }
  }

  /// A one-hour timed event at 9am on `day` of the week.
  private func timed(_ id: String, day: Int, zone: WorkingZone) -> TestEvent {
    let start = midnight(2026, 1, 5 + day, in: zone).ms + 9 * 3_600_000
    return TestEvent(id: id, startMs: start, endMs: start + 3_600_000, allDay: false)
  }

  /// Each day's events, as the month grid buckets them: all-day ones on every
  /// day they cover, all-day first.
  private func layout(_ zone: WorkingZone, _ events: [TestEvent], rows: Int = 4) -> MonthWeekLayout<TestEvent> {
    let days = week(zone)
    let byDay = days.indices.map { day in
      events.filter { event in
        if !event.allDay { return zone.isSameDay(Date(ms: event.startMs), days[day]) }
        let span = allDayRawSpan(startMs: event.startMs, endMs: event.endMs, days: days, zone: zone)
        return span.startIdx <= day && day <= span.endIdx
      }
      .sorted { a, b in a.allDay && !b.allDay }
    }
    return layoutMonthWeek(days: days, dayEvents: byDay, rows: rows, zone: zone)
  }

  @Test(arguments: testZones)
  func drawsAMultiDayEventAsOneBar(zone: WorkingZone) {
    let result = layout(zone, [allDayEvent("span", 1, 4)])
    #expect(result.bars.count == 1)
    let bar = result.bars[0]
    #expect((bar.startIdx, bar.endIdx, bar.lane) == (1, 3, 0))
    #expect(!bar.continuesBefore && !bar.continuesAfter)
    #expect(result.days[0].isEmpty)
    #expect(result.days[1...3].allSatisfy { $0 == [.bar] })
  }

  @Test(arguments: testZones)
  func keepsSingleDayAllDayEventsAsChips(zone: WorkingZone) {
    let single = allDayEvent("single", 2, 3)
    let result = layout(zone, [single])
    #expect(result.bars.isEmpty)
    #expect(result.days[2] == [.chip(single)])
  }

  @Test(arguments: testZones)
  func cutsABarAtTheRowsEdgesAndMarksItContinuing(zone: WorkingZone) {
    // From the Saturday before to the Tuesday after the week.
    let result = layout(zone, [allDayEvent("long", -2, 9)])
    #expect(result.bars.count == 1)
    let bar = result.bars[0]
    #expect((bar.startIdx, bar.endIdx) == (0, 6))
    #expect(bar.continuesBefore && bar.continuesAfter)
  }

  @Test(arguments: testZones)
  func marksOnlyTheSideThatRunsOn(zone: WorkingZone) {
    let result = layout(zone, [allDayEvent("weekend", 5, 9), allDayEvent("tail", -1, 2)])
    let byId = Dictionary(uniqueKeysWithValues: result.bars.map { ($0.event.id, $0) })
    #expect(byId["weekend"].map { ($0.startIdx, $0.endIdx, $0.continuesBefore, $0.continuesAfter) == (5, 6, false, true) } == true)
    #expect(byId["tail"].map { ($0.startIdx, $0.endIdx, $0.continuesBefore, $0.continuesAfter) == (0, 1, true, false) } == true)
  }

  @Test(arguments: testZones)
  func fillsFreeRowsWithTimedEvents(zone: WorkingZone) {
    // "first" holds row 0 on Mon–Tue, "second" row 1 on Tue–Wed: on Wednesday
    // row 0 is free again and the timed event takes it.
    let meeting = timed("meeting", day: 2, zone: zone)
    let result = layout(zone, [allDayEvent("first", 0, 2), allDayEvent("second", 1, 3), meeting])
    #expect(result.days[2] == [.chip(meeting), .bar])
    #expect(result.days[1] == [.bar, .bar])
  }

  @Test(arguments: testZones)
  func cutsABarWhereItFallsUnderTheCount(zone: WorkingZone) {
    // "span" sits in row 1 from Tuesday to Thursday. Wednesday has two more
    // events, so with two rows it shows one and "+2 more": the bar is hidden
    // there and drawn as a Tuesday piece and a Thursday piece.
    let b = allDayEvent("b", 2, 3)
    let events = [allDayEvent("a", 0, 2), allDayEvent("span", 1, 4), b, allDayEvent("c", 2, 3)]
    let result = layout(zone, events, rows: 2)
    #expect(result.days[2] == [.chip(b), .more(2)])
    let pieces = result.bars.filter { $0.event.id == "span" }.map { ($0.startIdx, $0.endIdx, $0.continuesBefore, $0.continuesAfter) }
    #expect(pieces.count == 2)
    #expect(pieces.first.map { $0 == (1, 1, false, true) } == true)
    #expect(pieces.last.map { $0 == (3, 3, true, false) } == true)
  }

  @Test(arguments: testZones)
  func showsEveryRowWhenTheyFit(zone: WorkingZone) {
    let events = (0..<3).map { timed("t\($0)", day: 4, zone: zone) }
    #expect(layout(zone, events, rows: 3).days[4] == events.map { .chip($0) })
    #expect(layout(zone, events, rows: 2).days[4] == [.chip(events[0]), .more(2)])
  }
}
