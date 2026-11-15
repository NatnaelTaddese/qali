import Foundation
import Testing
@testable import QaliDomain

// Port of allday.test.ts, run in zones on both sides of UTC: all-day bounds
// are UTC midnights, so a zone-local day diff would shift them.

@Suite struct LayoutAllDayEventsTests {
  private func lanes(_ zone: WorkingZone, _ events: [TestEvent], _ start: Int = 0, _ end: Int? = nil)
    -> [String: AllDayEventLayout<TestEvent>]
  {
    Dictionary(uniqueKeysWithValues: layoutAllDayEvents(
      days: testDays(zone), events: events, zone: zone, visibleStartIdx: start, visibleEndIdx: end
    ).map { ($0.event.id, $0) })
  }

  @Test(arguments: testZones)
  func reusesALaneWhenEventSpansDoNotOverlap(zone: WorkingZone) {
    let layout = layoutAllDayEvents(
      days: testDays(zone), events: [allDayEvent("monday", 0, 1), allDayEvent("tuesday", 1, 2)], zone: zone)
    #expect(layout.map(\.lane) == [0, 0])
    #expect(layout.map(\.startIdx) == [0, 1])
  }

  @Test(arguments: testZones)
  func assignsConcurrentEventsToSeparateLanes(zone: WorkingZone) {
    let layout = layoutAllDayEvents(
      days: testDays(zone),
      events: [allDayEvent("first", 0, 1), allDayEvent("second", 0, 1), allDayEvent("third", 0, 1)],
      zone: zone)
    #expect(layout.map(\.lane) == [0, 1, 2])
    #expect(visibleAllDayMetrics(layout, visibleStartIdx: 0, visibleEndIdx: 0) == (3, 1))
  }

  @Test(arguments: testZones)
  func reservesALaneAcrossAMultiDayEventSpan(zone: WorkingZone) {
    let layout = lanes(zone, [allDayEvent("spanning", 0, 3), allDayEvent("tuesday", 1, 2), allDayEvent("wednesday", 2, 3)])
    #expect(layout.mapValues(\.lane) == ["spanning": 0, "tuesday": 1, "wednesday": 1])
  }

  @Test(arguments: testZones)
  func countsOverflowOnlyWithinTheVisibleDayRange(zone: WorkingZone) {
    let layout = layoutAllDayEvents(
      days: testDays(zone),
      events: [allDayEvent("first", 3, 4), allDayEvent("second", 3, 4), allDayEvent("third", 3, 4)],
      zone: zone)
    #expect(visibleAllDayMetrics(layout, visibleStartIdx: 0, visibleEndIdx: 1) == (0, 0))
    #expect(visibleAllDayMetrics(layout, visibleStartIdx: 3, visibleEndIdx: 3) == (3, 1))
  }

  @Test(arguments: testZones)
  func packsLanesGloballyButClampsSpansToTheVisibleRange(zone: WorkingZone) {
    let events = [allDayEvent("first", 0, 3), allDayEvent("second", 0, 3), allDayEvent("continuing", 1, 5)]
    let full = lanes(zone, events, 0, 4)["continuing"]!
    #expect((full.lane, full.startIdx, full.endIdx) == (2, 1, 4))

    let scrolled = lanes(zone, events, 3, 4)
    #expect(scrolled["first"] == nil)
    #expect(scrolled["second"] == nil)
    let continuing = scrolled["continuing"]!
    #expect((continuing.lane, continuing.startIdx, continuing.endIdx) == (2, 3, 4))
  }

  @Test(arguments: testZones)
  func ordersLanesByTrueStartNotInputOrder(zone: WorkingZone) {
    let layout = lanes(zone, [allDayEvent("late", 1, 5), allDayEvent("early", 0, 2)])
    #expect(layout.mapValues(\.lane) == ["early": 0, "late": 1])
  }

  @Test func bandHeightFollowsTheLaneCount() {
    #expect(allDayBandHeight(laneCount: 0, expanded: false) == 28)
    #expect(allDayBandHeight(laneCount: 5, expanded: false) == 52)
    #expect(allDayBandHeight(laneCount: 5, expanded: true) == 124)
  }
}
