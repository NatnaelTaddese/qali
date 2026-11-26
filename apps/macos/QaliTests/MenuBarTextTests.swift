import Foundation
import QaliDomain
import Testing
@testable import Qali

/// The menu bar item says which way its countdown runs.
@MainActor
struct MenuBarTextTests {
  /// 14:00 on some day; the event runs 14:25–15:00 unless moved.
  let now = Date(timeIntervalSince1970: 1_795_500_000)
  var start: Double { now.ms + 25 * 60_000 }
  var end: Double { now.ms + 60 * 60_000 }

  private func text(startMs: Double? = nil, endMs: Double? = nil, titles: Bool = true, joining: Bool = false) -> String {
    nextUpText(
      summary: "Standup", startMs: startMs ?? start, endMs: endMs ?? end,
      now: now, showTitles: titles, joining: joining
    )
  }

  @Test func beforeItStartsItCountsTowardsTheStart() {
    #expect(text() == "Standup · in 25m")
    #expect(text(startMs: now.ms + 65 * 60_000, endMs: now.ms + 120 * 60_000) == "Standup · in 1h 5m")
    #expect(text(titles: false) == "Event in 25m")
  }

  @Test func onceStartedItCountsWhatIsLeft() {
    let started = now.ms - 5 * 60_000
    #expect(text(startMs: started) == "Standup · 1h left")
    #expect(text(startMs: started, endMs: now.ms + 25 * 60_000) == "Standup · 25m left")
    #expect(text(startMs: started, endMs: now.ms + 25 * 60_000, titles: false) == "Event · 25m left")
  }

  @Test func besideTheJoinPillThereIsRoomForLess() {
    #expect(text(joining: true) == "Standup")
    #expect(text(titles: false, joining: true) == "in 25m")
    #expect(text(startMs: now.ms - 60_000, endMs: now.ms + 25 * 60_000, titles: false, joining: true) == "25m left")
  }

  @Test func longTitlesAreCut() {
    let long = nextUpText(
      summary: "Quarterly planning with everyone", startMs: start, endMs: end,
      now: now, showTitles: true, joining: false
    )
    #expect(long == "Quarterly planning… · in 25m")
  }
}

/// Which event the menu bar item points at.
@MainActor
struct NextUpEventTests {
  let zone = WorkingZone(identifier: "Asia/Shanghai")!
  /// 10:23 in Shanghai on Thu 26 Nov 2026.
  let now = ISO8601DateFormatter().date(from: "2026-11-26T02:23:00Z")!

  private func event(_ id: String, from start: Double, to end: Double) -> CalendarEvent {
    // Minutes from now.
    CalendarEvent(id: id, startMs: now.ms + start * 60_000, endMs: now.ms + end * 60_000, allDay: false, status: "confirmed")
  }

  private func next(_ events: [CalendarEvent], lookahead: Int = 180) -> String? {
    nextUpEvent(events, now: now, lookahead: lookahead, zone: zone)?.id
  }

  @Test func anEventUnderWayStaysUntilItEnds() {
    // Started 23 minutes ago, 1h 22m to go, nothing after it.
    #expect(next([event("dubay", from: -23, to: 82)]) == "dubay")
  }

  @Test func theNextEventTakesOverTenMinutesBefore() {
    let long = event("long", from: -30, to: 90)
    #expect(next([long, event("soon", from: 8, to: 30)]) == "soon")
    #expect(next([long, event("later", from: 40, to: 60)]) == "long")
  }

  @Test func aJustStartedEventBeatsTheNextOne() {
    #expect(next([event("late", from: -5, to: 25), event("soon", from: 3, to: 30)]) == "late")
  }

  @Test func ofTwoUnderWayTheLatestStartedWins() {
    #expect(next([event("block", from: -120, to: 120), event("meeting", from: -20, to: 40)]) == "meeting")
  }

  @Test func withNothingUnderWayItIsTheNextWithinTheLookahead() {
    #expect(next([event("later", from: 40, to: 60)]) == "later")
    #expect(next([event("far", from: 200, to: 230)]) == nil)
    #expect(next([event("over", from: -60, to: -5)]) == nil)
  }
}
