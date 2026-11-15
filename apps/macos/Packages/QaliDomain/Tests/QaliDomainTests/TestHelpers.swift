import Foundation
@testable import QaliDomain

// Port of packages/domain/src/calendar/test-helpers.ts. The TypeScript helpers
// use runner-local dates; here the zone is explicit, and suites that depend on
// it run across several zones instead of whichever one the machine is in.

struct TestEvent: CalendarEventLike, ColorableEventLike, Equatable {
  var id: String
  var startMs: Double
  var endMs: Double
  var allDay: Bool
  var color: String? = nil
  var localCalendarId: String? = nil
}

let newYork = WorkingZone(identifier: "America/New_York")!
let kiritimati = WorkingZone(identifier: "Pacific/Kiritimati")!  // UTC+14, no DST

/// Zones with offsets on both sides of UTC, plus the date-line extreme.
let testZones = [
  "America/Los_Angeles", "America/New_York", "UTC", "Asia/Kolkata", "Pacific/Kiritimati",
].map { WorkingZone(identifier: $0)! }

/// Midnight of a calendar date in `zone` (month is 1-based, unlike JS).
func midnight(_ year: Int, _ month: Int, _ day: Int, in zone: WorkingZone) -> Date {
  zone.date(year: year, month: month, day: day)
}

/// Five days from Monday 5 Jan 2026 in `zone`.
func testDays(_ zone: WorkingZone) -> [Date] {
  (0..<5).map { midnight(2026, 1, 5 + $0, in: zone) }
}

func dayStart(_ zone: WorkingZone = newYork) -> Double {
  midnight(2026, 1, 5, in: zone).ms
}

/// A timed event on the test day, from `startH:startM` to `endH:endM` (24h).
func timedEvent(
  _ id: String, _ startH: Double, _ startM: Double, _ endH: Double, _ endM: Double,
  zone: WorkingZone = newYork
) -> TestEvent {
  let at = { (h: Double, m: Double) in dayStart(zone) + (h * 60 + m) * msPerMinute }
  return TestEvent(id: id, startMs: at(startH, startM), endMs: at(endH, endM), allDay: false)
}

/// An all-day event spanning `[startDay, endDayExclusive)` days from the test
/// Monday, with Google's UTC-midnight bounds.
func allDayEvent(_ id: String, _ startDay: Int, _ endDayExclusive: Int) -> TestEvent {
  let utc = WorkingZone(identifier: "UTC")!
  return TestEvent(
    id: id,
    startMs: midnight(2026, 1, 5 + startDay, in: utc).ms,
    endMs: midnight(2026, 1, 5 + endDayExclusive, in: utc).ms,
    allDay: true
  )
}
