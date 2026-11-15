import Foundation
import Testing
@testable import QaliDomain

// Swift-vs-TypeScript parity. The expected values were produced by running
// the TypeScript sources in packages/domain with bun; regenerate them from
// there if the TS changes (see Fixtures/README.md).

@Suite struct ColorParityTests {
  @Test func snapToPaletteMatchesTypeScript() {
    let expected: [String: String] = [
      "#7986cb": "--event-7", "#33b679": "--event-4", "#8e24aa": "--event-8", "#e67c73": "--event-1",
      "#f6c026": "--event-3", "#f5511d": "--event-2", "#039be5": "--event-6", "#616161": "--event-neutral",
      "#3f51b5": "--event-7", "#0b8043": "--event-4", "#d60000": "--event-1", "#9fe1e7": "--event-5",
      "#ac725e": "--event-2", "#ffffff": "--event-neutral", "#000000": "--event-neutral",
      "#a4bdfc": "--event-7", "not-a-hex": "--event-neutral",
    ]
    for (hex, key) in expected {
      #expect(snapToPalette(hex).rawValue == key, "\(hex)")
    }
  }

  @Test func idHashMatchesTypeScript() {
    let expected: [String: String] = [
      "": "--event-1", "a": "--event-2", "jd7abc123xyz": "--event-5",
      "k57f2qg3h8m1n0p4r6s9t": "--event-5", "calendar-😀-id": "--event-7",
      "ZZZZZZZZZZZZZZZZZZZZZZZZZZ": "--event-1",
    ]
    for (id, key) in expected {
      #expect(calendarColorKey(id: id, backgroundColor: nil).rawValue == key, "\(id)")
    }
  }

  @Test func colorChoicesMatchTypeScript() {
    let expected = [
      ("--event-1", "4"), ("--event-2", "6"), ("--event-3", "5"), ("--event-4", "2"),
      ("--event-6", "7"), ("--event-7", "1"), ("--event-8", "3"), ("--event-neutral", "8"),
    ]
    #expect(eventColorChoices.map { $0.key.rawValue } == expected.map(\.0))
    #expect(eventColorChoices.map(\.color) == expected.map(\.1))
  }

  @Test func eventColorResolutionOrderMatchesTypeScript() {
    #expect(eventColorKey(TestEvent(id: "e1", startMs: 0, endMs: 0, allDay: false, color: "7")) == .event6)
    #expect(eventColorKey(TestEvent(id: "e2", startMs: 0, endMs: 0, allDay: false, localCalendarId: "c1"),
                          calendarColors: ["c1": "#f6c026"]) == .event3)
    #expect(eventColorKey(TestEvent(id: "e3", startMs: 0, endMs: 0, allDay: false, localCalendarId: "c2"),
                          calendarColors: [:]) == .event8)
    #expect(eventColorKey(TestEvent(id: "e4", startMs: 0, endMs: 0, allDay: false)) == .event8)
  }
}

/// Randomised layouts computed by the TypeScript implementation.
private struct LayoutFixture: Decodable {
  struct Event: Decodable {
    let _id: String
    let startMs: Double
    let endMs: Double
    let allDay: Bool
    var testEvent: TestEvent { TestEvent(id: _id, startMs: startMs, endMs: endMs, allDay: allDay) }
  }
  struct Positioned: Decodable {
    let id: String
    let topPct, heightPct, laneAdvance: Double
    let stackIndex, stackCount, elevation, columnIndex, columnCount, columnSpan: Int
  }
  struct AllDay: Decodable {
    let id: String
    let startIdx, endIdx, lane: Int
  }
  struct Bucket: Decodable {
    let allDay: [String]
    let timedByDay: [[String]]
  }
  struct Scenario: Decodable {
    let timed, allDay: [Event]
    let dayLayout, weekLayout: [Positioned]
    let allDayLayout: [AllDay]
    let bucket: Bucket
  }
  struct Range: Decodable { let startMs, endMs: Double }

  let zone: String
  let days: [Double]
  let dayStart: Double
  let queryRange: Range
  let scenarios: [Scenario]
}

@Suite struct LayoutParityTests {
  private static let fixtures = ["layout-America-Los_Angeles", "layout-Asia-Kolkata"]

  private func load(_ name: String) throws -> LayoutFixture {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try JSONDecoder().decode(LayoutFixture.self, from: Data(contentsOf: url))
  }

  private func expectMatches(_ actual: [PositionedEvent<TestEvent>], _ expected: [LayoutFixture.Positioned]) {
    #expect(actual.map(\.event.id) == expected.map(\.id))
    for (a, e) in zip(actual, expected) {
      #expect(abs(a.topPct - e.topPct) < 1e-9, "\(e.id) topPct")
      #expect(abs(a.heightPct - e.heightPct) < 1e-9, "\(e.id) heightPct")
      #expect(abs(a.laneAdvance - e.laneAdvance) < 1e-12, "\(e.id) laneAdvance")
      let actualInts: [Int] = [a.stackIndex, a.stackCount, a.elevation, a.columnIndex, a.columnCount, a.columnSpan]
      let expectedInts: [Int] = [e.stackIndex, e.stackCount, e.elevation, e.columnIndex, e.columnCount, e.columnSpan]
      #expect(actualInts == expectedInts, "\(e.id)")
    }
  }

  @Test(arguments: fixtures)
  func stripDaysAndQueryWindowMatch(name: String) throws {
    let fixture = try load(name)
    let zone = try #require(WorkingZone(identifier: fixture.zone))
    let anchor = Date(ms: fixture.days[6])
    #expect(stripDays(anchor: anchor, columns: 3, side: 6, zone: zone).map(\.ms) == fixture.days)
    let range = eventQueryRange(.week, anchor: anchor, zone: zone)
    #expect(range.startMs == fixture.queryRange.startMs)
    #expect(range.endMs == fixture.queryRange.endMs)
  }

  @Test(arguments: fixtures)
  func timedLayoutsMatch(name: String) throws {
    let fixture = try load(name)
    for scenario in fixture.scenarios {
      let events = scenario.timed.map(\.testEvent)
      expectMatches(layoutDayEvents(events, dayStartMs: fixture.dayStart), scenario.dayLayout)
      expectMatches(
        layoutDayEvents(events, dayStartMs: fixture.dayStart, tileMaxStaggerMs: weekLaneTileMaxStaggerMs),
        scenario.weekLayout
      )
    }
  }

  @Test(arguments: fixtures)
  func allDayLayoutsAndBucketsMatch(name: String) throws {
    let fixture = try load(name)
    let zone = try #require(WorkingZone(identifier: fixture.zone))
    let days = fixture.days.map { Date(ms: $0) }
    for scenario in fixture.scenarios {
      let allDay = scenario.allDay.map(\.testEvent)
      let layout = layoutAllDayEvents(days: days, events: allDay, zone: zone, visibleStartIdx: 5, visibleEndIdx: 9)
      #expect(layout.map(\.event.id) == scenario.allDayLayout.map(\.id))
      #expect(layout.map(\.lane) == scenario.allDayLayout.map(\.lane))
      #expect(layout.map(\.startIdx) == scenario.allDayLayout.map(\.startIdx))
      #expect(layout.map(\.endIdx) == scenario.allDayLayout.map(\.endIdx))

      let bucket = bucketDayEvents(days: days, events: scenario.timed.map(\.testEvent) + allDay)
      #expect(bucket.allDayEvents.map(\.id) == scenario.bucket.allDay)
      #expect(bucket.timedByDay.map { $0.map(\.id) } == scenario.bucket.timedByDay)
    }
  }
}
