import Foundation
import Testing
@testable import QaliDomain

// Port of now.test.ts, in a fixed zone instead of the runner's.

@Suite struct NowIndicatorLayoutTests {
  let zone = WorkingZone(identifier: "Europe/Berlin")!
  let weekSide = stripSideDays(.week)
  let daySide = stripSideDays(.day)

  func at(_ month: Int, _ day: Int, _ hour: Int = 0, _ minute: Int = 0) -> Double {
    zone.calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute))!.ms
  }

  @Test func positionsTodaysColumnWithinTheFullBufferedStrip() throws {
    let days = stripDays(anchor: Date(ms: at(7, 13)), columns: viewColumns(.week), side: weekSide, zone: zone)
    let layout = try #require(nowIndicatorLayout(days: days, nowMs: at(7, 19, 9, 30), zone: zone))
    let todayIdx = weekSide + 6
    #expect(layout.today?.todayIndex == todayIdx)
    #expect(abs(layout.today!.leftPct - Double(todayIdx) / Double(days.count) * 100) < 1e-9)
    #expect(abs(layout.today!.widthPct - 100 / Double(days.count)) < 1e-9)
    #expect(abs(layout.topPct - 9.5 / 24 * 100) < 1e-9)
  }

  @Test func positionsTodaysColumnWithinABufferedDayStrip() throws {
    let days = stripDays(anchor: Date(ms: at(7, 19)), columns: viewColumns(.day), side: daySide, zone: zone)
    let layout = try #require(nowIndicatorLayout(days: days, nowMs: at(7, 19, 15), zone: zone))
    #expect(abs(layout.today!.leftPct - Double(daySide) / Double(days.count) * 100) < 1e-9)
    #expect(abs(layout.topPct - 15.0 / 24 * 100) < 1e-9)
  }

  @Test func stillShowsTheLineWhenTodayIsOffTheVisibleWindow() throws {
    let days = stripDays(anchor: Date(ms: at(7, 20)), columns: viewColumns(.week), side: weekSide, zone: zone)
    let layout = try #require(nowIndicatorLayout(days: days, nowMs: at(7, 19, 12), zone: zone))
    #expect(abs(layout.topPct - 50) < 1e-9)
    #expect(layout.today != nil)
  }

  @Test func todaysColumnShiftsWhenTheDateRollsOverAtMidnight() {
    let days = stripDays(anchor: Date(ms: at(7, 13)), columns: viewColumns(.week), side: weekSide, zone: zone)
    let before = nowIndicatorLayout(days: days, nowMs: at(7, 19, 23, 59), zone: zone)
    let after = nowIndicatorLayout(days: days, nowMs: at(7, 20), zone: zone)
    #expect(before?.today?.todayIndex == weekSide + 6)
    #expect(after?.today?.todayIndex == weekSide + 7)
  }

  @Test func findsTodaysColumnAmongZoneCutDaysAndPositionsByZoneClock() throws {
    let anchor = pageStart(.day, Date(ms: straddleMs), zone: kiritimati)
    let days = stripDays(anchor: anchor, columns: 3, side: 0, zone: kiritimati)
    let layout = try #require(nowIndicatorLayout(days: days, nowMs: straddleMs, zone: kiritimati))
    #expect(layout.today != nil)
    #expect(abs(layout.topPct - 2.0 / 24 * 100) < 1e-5)
    let layoutNy = try #require(nowIndicatorLayout(days: days, nowMs: straddleMs, zone: newYork))
    #expect(abs(layoutNy.topPct - 8.0 / 24 * 100) < 1e-5)
  }

  @Test func noDaysNoLayout() {
    #expect(nowIndicatorLayout(days: [], nowMs: 0, zone: zone) == nil)
  }
}
