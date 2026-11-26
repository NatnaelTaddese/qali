import Foundation
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
