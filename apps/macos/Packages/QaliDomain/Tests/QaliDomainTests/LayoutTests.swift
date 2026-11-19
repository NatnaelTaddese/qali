import Foundation
import Testing
@testable import QaliDomain

// Port of layout.test.ts.

@Suite struct NextFreeSlotTests {
  let start = dayStart()
  func at(_ h: Double, _ m: Double = 0) -> Double { start + (h * 60 + m) * msPerMinute }
  /// A moment before the test day so "today" logic never kicks in for it.
  var beforeDay: Double { start - msPerDay }
  let none: [TestEvent] = []

  @Test func defaultsToNineForHalfAnHourOnAnEmptyFutureDay() {
    let slot = nextFreeSlot(dayStartMs: start, events: none, nowMs: beforeDay)
    #expect(slot == (at(9), at(9, 30)))
  }

  @Test func skipsPastAnEventThatBlocksNine() {
    let slot = nextFreeSlot(dayStartMs: start, events: [timedEvent("a", 9, 0, 10, 0)], nowMs: beforeDay)
    #expect(slot == (at(10), at(10, 30)))
  }

  @Test func findsTheGapBetweenTwoMeetings() {
    let events = [timedEvent("a", 9, 0, 9, 30), timedEvent("b", 10, 0, 11, 0)]
    #expect(nextFreeSlot(dayStartMs: start, events: events, nowMs: beforeDay) == (at(9, 30), at(10)))
  }

  @Test func ignoresAllDayEvents() {
    let slot = nextFreeSlot(dayStartMs: start, events: [allDayEvent("a", 0, 1)], nowMs: beforeDay)
    #expect(slot == (at(9), at(9, 30)))
  }

  @Test func startsFromTheNextSnapBoundaryWhenTheDayIsToday() {
    #expect(nextFreeSlot(dayStartMs: start, events: none, nowMs: at(13, 5)) == (at(13, 15), at(13, 45)))
  }

  @Test func staysAtNineOnAPastDayEvenThoughNowIsLater() {
    let now = start + msPerDay + at(15) - start
    #expect(nextFreeSlot(dayStartMs: start, events: none, nowMs: now) == (at(9), at(9, 30)))
  }

  @Test func fallsBackToTheLastSlotBeforeMidnightOnAFullDay() {
    let slot = nextFreeSlot(dayStartMs: start, events: [timedEvent("all", 0, 0, 24, 0)], nowMs: beforeDay)
    #expect(slot == (at(23, 30), at(24)))
  }
}

private func byId(_ layout: [PositionedEvent<TestEvent>]) -> [String: PositionedEvent<TestEvent>] {
  Dictionary(uniqueKeysWithValues: layout.map { ($0.event.id, $0) })
}

@Suite struct LayoutDayEventsColumnTests {
  @Test func sequentialEventsEachStandAloneInASingleColumn() {
    let layout = byId(layoutDayEvents([timedEvent("a", 9, 0, 10, 0), timedEvent("b", 10, 0, 11, 0)], dayStartMs: dayStart()))
    for id in ["a", "b"] {
      #expect(layout[id]!.columnCount == 1)
      #expect(layout[id]!.columnIndex == 0)
      #expect(layout[id]!.columnSpan == 1)
    }
  }

  @Test func concurrentEventsSplitIntoAdjacentColumns() {
    let layout = byId(layoutDayEvents([timedEvent("a", 9, 0, 10, 0), timedEvent("b", 9, 0, 10, 0)], dayStartMs: dayStart()))
    #expect(layout["a"]!.columnCount == 2)
    #expect(layout["b"]!.columnCount == 2)
    #expect([layout["a"]!.columnIndex, layout["b"]!.columnIndex].sorted() == [0, 1])
    #expect(layout["a"]!.columnSpan == 1)
    #expect(layout["b"]!.columnSpan == 1)
  }

  @Test func aTransitiveOverlapChainThatIsNotAllConcurrentReusesALane() {
    let layout = byId(layoutDayEvents([
      timedEvent("a", 9, 0, 10, 0),
      timedEvent("b", 9, 30, 11, 0),
      timedEvent("c", 10, 30, 12, 0),
    ], dayStartMs: dayStart()))
    #expect(layout["a"]!.columnCount == 2)
    #expect(layout["a"]!.columnIndex == 0)
    #expect(layout["b"]!.columnIndex == 1)
    #expect(layout["c"]!.columnIndex == 0)
  }

  @Test func aCardExpandsRightAcrossLanesLeftFreeByNonOverlappingNeighbours() {
    let layout = byId(layoutDayEvents([
      timedEvent("long", 9, 0, 11, 0),
      timedEvent("b", 9, 0, 9, 30),
      timedEvent("c", 9, 0, 9, 30),
      timedEvent("d", 10, 0, 10, 30),
    ], dayStartMs: dayStart()))
    #expect(layout["d"]!.columnCount == 3)
    #expect(layout["d"]!.columnIndex == 1)
    #expect(layout["d"]!.columnSpan == 2)
  }
}

@Suite struct LayoutDayEventsOverlapStyleTests {
  @Test func aComfortableStaggerKeepsTheOverlappingFan() {
    let layout = byId(layoutDayEvents([timedEvent("a", 11, 15, 14, 0), timedEvent("b", 12, 15, 13, 30)], dayStartMs: dayStart()))
    #expect(abs(layout["a"]!.laneAdvance - laneAdvanceRatio) < 1e-5)
    #expect(abs(layout["b"]!.laneAdvance - laneAdvanceRatio) < 1e-5)
  }

  @Test func aCloseStaggerTilesTheClusterIntoCleanColumns() {
    let layout = byId(layoutDayEvents([timedEvent("a", 11, 15, 14, 0), timedEvent("b", 11, 30, 12, 45)], dayStartMs: dayStart()))
    let a = layout["a"]!, b = layout["b"]!
    #expect(a.laneAdvance == 1)
    #expect(b.laneAdvance == 1)
    let boxA = laneBox(columnIndex: a.columnIndex, columnCount: a.columnCount, columnSpan: a.columnSpan, advance: a.laneAdvance)
    let boxB = laneBox(columnIndex: b.columnIndex, columnCount: b.columnCount, columnSpan: b.columnSpan, advance: b.laneAdvance)
    #expect(abs(boxA.left + boxA.width - boxB.left) < 1e-5)
  }

  @Test func aWiderStaggerThresholdTilesAPairTheDefaultKeepsFanned() {
    let events = [timedEvent("a", 11, 0, 14, 0), timedEvent("b", 11, 40, 13, 0)]
    let day = byId(layoutDayEvents(events, dayStartMs: dayStart()))
    #expect(abs(day["a"]!.laneAdvance - laneAdvanceRatio) < 1e-5)
    let week = byId(layoutDayEvents(events, dayStartMs: dayStart(), tileMaxStaggerMs: weekLaneTileMaxStaggerMs))
    #expect(week["a"]!.laneAdvance == 1)
    #expect(week["b"]!.laneAdvance == 1)
  }

  @Test func aWholeClusterTilesWhenAnyOverlappingPairStartsTooClose() {
    let layout = byId(layoutDayEvents([
      timedEvent("a", 9, 0, 12, 0),
      timedEvent("b", 10, 0, 12, 0),
      timedEvent("c", 10, 10, 12, 0),
    ], dayStartMs: dayStart()))
    for id in ["a", "b", "c"] { #expect(layout[id]!.laneAdvance == 1) }
  }

  @Test func eventsThatDontOverlapInTimeNeverTileOnACloseStartAlone() {
    let layout = byId(layoutDayEvents([timedEvent("a", 9, 0, 9, 30), timedEvent("b", 9, 30, 10, 0)], dayStartMs: dayStart()))
    #expect(layout["a"]!.columnCount == 1)
    #expect(abs(layout["a"]!.laneAdvance - laneAdvanceRatio) < 1e-5)
    #expect(abs(layout["b"]!.laneAdvance - laneAdvanceRatio) < 1e-5)
  }
}

@Suite struct LaneBoxTests {
  @Test func aLoneCardFillsTheWholeColumn() {
    #expect(laneBox(columnIndex: 0, columnCount: 1, columnSpan: 1) == (0, 1))
  }

  @Test func twoLanesOverlapRatherThanSplittingIntoCleanHalves() {
    let a = laneBox(columnIndex: 0, columnCount: 2, columnSpan: 1)
    let b = laneBox(columnIndex: 1, columnCount: 2, columnSpan: 1)
    #expect(a.width > 0.5)
    #expect(a.left == 0)
    #expect(b.left < 0.5)
    #expect(abs(b.left + b.width - 1) < 1e-5)
  }

  @Test func advanceOneTilesLanesIntoCleanEqualNonOverlappingHalves() {
    let a = laneBox(columnIndex: 0, columnCount: 2, columnSpan: 1, advance: 1)
    let b = laneBox(columnIndex: 1, columnCount: 2, columnSpan: 1, advance: 1)
    #expect(a.left == 0)
    #expect(abs(a.width - 0.5) < 1e-5)
    #expect(abs(b.left - 0.5) < 1e-5)
    #expect(abs(b.left + b.width - 1) < 1e-5)
  }

  @Test func aSpanningCardExtendsToTheColumnsRightEdge() {
    let box = laneBox(columnIndex: 0, columnCount: 2, columnSpan: 2)
    #expect(box.left == 0)
    #expect(abs(box.width - 1) < 1e-5)
  }
}
