import ConvexMobile
import Foundation
import Testing
@testable import Qali

/// The booking link's client-side rules, which must match the web's and the
/// server's (packages/domain/src/slug.ts, availability.ts).
@MainActor
struct BookingTests {
  @Test func normalizesSlugsLikeTheWeb() {
    #expect(normalizeSlug("  Nat Taddese ") == "nat-taddese")
    #expect(normalizeSlug("my_name__here") == "my-name-here")
    #expect(normalizeSlug("Ünïcode & co!") == "ncode-co")
    #expect(normalizeSlug("a--b") == "a-b")
    #expect(normalizeSlug(String(repeating: "x", count: 40)).count == 30)
  }

  @Test func rejectsSlugsInTheServersWords() {
    #expect(slugError("ab") == "Use at least 3 characters")
    #expect(slugError("-abc") == "Can't start or end with a hyphen")
    #expect(slugError("settings") == "That name is reserved")
    #expect(slugError("nat") == nil)
  }

  @Test func mergesOverlappingAndTouchingSpans() {
    let merged = mergeDayIntervals([
      DayInterval(startMin: 600, endMin: 720),
      DayInterval(startMin: 540, endMin: 600),
      DayInterval(startMin: 900, endMin: 960),
      DayInterval(startMin: 700, endMin: 800),
    ])
    #expect(merged == [DayInterval(startMin: 540, endMin: 800), DayInterval(startMin: 900, endMin: 960)])
  }

  @Test func draftWritesOpenDaysMondayFirst() {
    let page = BookingPage(
      id: "p", slug: "nat", displayName: "Nat", timeZone: "Europe/Berlin", title: nil, description: nil,
      slotMinutes: 45, bufferMinutes: 0, minNoticeMinutes: 90, horizonDays: 30,
      rules: [WeeklyRule(weekday: 0, startMin: 600, endMin: 720), WeeklyRule(weekday: 2, startMin: 540, endMin: 1020)],
      enabled: true)
    var draft = BookingPageDraft(page: page, defaults: nil)
    #expect(draft.noticeHours == 2)
    #expect(draft.rules.map(\.weekday) == [2, 0])
    // A day that ends before it starts is left out, not sent.
    draft.days[3] = .init(enabled: true, startMin: 600, endMin: 540)
    #expect(draft.rules.map(\.weekday) == [2, 0])
    draft.copyHoursToOpenDays(from: 2)
    #expect(draft.days[0].startMin == 540 && draft.days[3].endMin == 1020)
    #expect(draft.days[1].enabled == false)
  }

  @Test func readsTheServersErrorLine() {
    let error = ClientError.ServerError(msg: "[Request ID: abc] Server Error\nUncaught Error: That link is already taken\n    at handler (x.js:1)")
    #expect(bookingErrorMessage(error) == "That link is already taken")
  }
}
