import Foundation
import Testing
@testable import QaliDomain

// Port of zone.test.ts.

/// 2026-08-26T12:00Z is Wed Aug 26 everywhere except UTC+14, where it is
/// 02:00 Thu Aug 27 — an instant that straddles the date line.
let straddleMs = ISO8601DateFormatter().date(from: "2026-08-26T12:00:00Z")!.ms

@Suite struct FormatWallClockMinutesTests {
  @Test func formatsWallClockBoundsWithoutADateOrTimezone() {
    #expect(formatWallClockMinutes(0) == "12:00 AM")
    #expect(formatWallClockMinutes(9 * 60 + 15, includeDayPeriod: false) == "9:15")
    #expect(formatWallClockMinutes(13 * 60 + 5) == "1:05 PM")
    #expect(formatWallClockMinutes(24 * 60) == "12:00 AM")
    #expect(formatWallClockMinutes(13 * 60 + 5, use24h: true) == "13:05")
    #expect(formatWallClockMinutes(-30) == "11:30 PM")
  }
}

@Suite struct WorkingZoneDayCutTests {
  @Test func theSameInstantLandsOnDifferentCalendarDaysPerZone() {
    #expect(newYork.format(Date(ms: straddleMs), "yyyy-MM-dd") == "2026-08-26")
    #expect(kiritimati.format(Date(ms: straddleMs), "yyyy-MM-dd") == "2026-08-27")
  }

  @Test func pageStartCutsTheWeekAtTheWorkingZonesMidnight() {
    let weekNy = pageStart(.week, Date(ms: straddleMs), weekStartsOn: .monday, zone: newYork)
    let weekKi = pageStart(.week, Date(ms: straddleMs), weekStartsOn: .monday, zone: kiritimati)
    #expect(newYork.format(weekNy, "EEE HH:mm") == "Mon 00:00")
    #expect(kiritimati.format(weekKi, "EEE HH:mm") == "Mon 00:00")
    #expect(weekNy.ms - weekKi.ms == 18 * msPerHour)
  }

  @Test func stripDaysYieldsConsecutiveWorkingZoneMidnights() {
    let anchor = pageStart(.day, Date(ms: straddleMs), zone: newYork)
    for day in stripDays(anchor: anchor, columns: 3, side: 1, zone: newYork) {
      #expect(newYork.format(day, "HH:mm") == "00:00")
    }
  }

  @Test func monthPagesCarryTheZoneThroughThe6x7Grid() {
    let start = pageStart(.month, Date(ms: straddleMs), zone: kiritimati)
    let days = pageDays(.month, start, zone: kiritimati)
    #expect(days.count == 42)
    #expect(kiritimati.format(days[0], "HH:mm") == "00:00")
    #expect(kiritimati.format(days[41], "HH:mm") == "00:00")
  }
}

@Suite struct EventTimePartsTests {
  @Test(arguments: testZones)
  func allDayBoundsShowTheDayGoogleMeantInEveryZone(zone: WorkingZone) {
    // Mon 5 – Wed 7 Jan inclusive, stored as [UTC Jan 5, UTC Jan 8).
    guard case .allDay(let start, let lastDay) = eventTimeParts(allDayEvent("a", 0, 3), use24h: false, zone: zone)
    else { Issue.record("expected all-day parts"); return }
    #expect(zone.format(start, "EEE d") == "Mon 5")
    #expect(zone.format(lastDay, "EEE d") == "Wed 7")
  }

  @Test func timedEndTextSpellsOutTheDayOnlyWhenItChanges() {
    let sameDay = timedEvent("a", 9, 0, 10, 30)
    guard case .timed(_, _, let pattern, let endText) = eventTimeParts(sameDay, use24h: false, zone: newYork)
    else { Issue.record("expected timed parts"); return }
    #expect(pattern == "h:mm a")
    #expect(endText == "10:30 AM")

    let overnight = timedEvent("b", 22, 0, 26, 0)
    guard case .timed(_, _, _, let overnightEnd) = eventTimeParts(overnight, use24h: true, zone: newYork)
    else { Issue.record("expected timed parts"); return }
    #expect(overnightEnd == "Tue 6 Jan, 02:00")
  }

  @Test func zoneHelpers() {
    #expect(zoneShortLabel("America/New_York") == "New York")
    #expect(zoneShortLabel("UTC") == "UTC")
    #expect(WorkingZone.resolve(preference: "Not/AZone") == WorkingZone(.current))
    #expect(WorkingZone.resolve(preference: "Asia/Tokyo").identifier == "Asia/Tokyo")
    #expect(dayKey(Date(ms: dayStart() + 5 * msPerHour), zone: newYork) == "day:\(Int64(dayStart()))")
  }
}
