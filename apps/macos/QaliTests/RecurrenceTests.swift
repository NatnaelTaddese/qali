import Foundation
import QaliDomain
import Testing
@testable import Qali

/// The repeat model (the web's rrule.ts and its tests).
@MainActor
struct RecurrenceTests {
  /// A fixed working zone so the assertions don't depend on the machine's.
  let zone = WorkingZone(identifier: "America/New_York")!

  private func summary(_ line: String) -> String? {
    Recurrence.parse([line], zone: zone)?.summary(zone: zone)
  }

  @Test func describesADailyRuleWithAnEndDate() {
    #expect(summary("RRULE:FREQ=DAILY;UNTIL=20260826T235959Z") == "Daily · until Aug 26, 2026")
  }

  @Test func readsAGoogleNormalisedUntilAsTheAuthoredDay() {
    #expect(summary("RRULE:FREQ=DAILY;UNTIL=20260827T035959Z") == "Daily · until Aug 26, 2026")
    #expect(summary("RRULE:FREQ=DAILY;UNTIL=20260826") == "Daily · until Aug 26, 2026")
  }

  @Test func describesWeeklyDaysInOrder() {
    #expect(summary("RRULE:FREQ=WEEKLY;BYDAY=WE,MO") == "Weekly on Mon, Wed")
    #expect(summary("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR") == "Every weekday")
  }

  @Test func describesIntervalsAndCounts() {
    #expect(summary("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=5") == "Every 2 weeks on Fri · 5 times")
  }

  @Test func ignoresOtherRecurrenceLines() {
    #expect(Recurrence.parse(["EXDATE:20260812T090000Z", "RRULE:FREQ=MONTHLY"], zone: zone)?.summary(zone: zone) == "Monthly")
  }

  @Test func rejectsMalformedOrUnsupportedRules() {
    #expect(summary("RRULE:FREQ=DAILY;INTERVAL=0") == nil)
    #expect(summary("RRULE:FREQ=MONTHLY;BYDAY=1MO") == nil)
    #expect(summary("RRULE:FREQ=DAILY;UNTIL=20260230") == nil)
    #expect(Recurrence.parse(["RDATE:20260826T090000Z"], zone: zone) == nil)
  }

  @Test func writesAndReadsBackTheSameRule() {
    let aug26 = zone.calendar.date(from: DateComponents(year: 2026, month: 8, day: 26))!.ms
    let rule = Recurrence(freq: .weekly, interval: 2, byWeekday: [.we, .mo], end: .onDate(aug26))
    let lines = rule.rrule(zone: zone)
    // The end of Aug 26 in New York, in UTC.
    #expect(lines == ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20260827T035959Z"])
    #expect(Recurrence.parse(lines, zone: zone) == rule)
  }

  @Test func presetsWriteTheirPlainRules() {
    #expect(Recurrence.daily().rrule(zone: zone) == ["RRULE:FREQ=DAILY"])
    #expect(Recurrence.everyWeekday().rrule(zone: zone) == ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"])
    #expect(Recurrence.yearly().rrule(zone: zone) == ["RRULE:FREQ=YEARLY"])
    #expect(Recurrence(freq: .daily, end: .count(3)).rrule(zone: zone) == ["RRULE:FREQ=DAILY;COUNT=3"])
  }

  @Test func weekdayTogglesNeverEmptyTheRule() {
    let rule = Recurrence.weekly(on: .mo)
    #expect(rule.toggling(.mo).byWeekday == [.mo])
    #expect(rule.toggling(.fr).byWeekday == [.mo, .fr])
    #expect(rule.toggling(.fr).toggling(.mo).byWeekday == [.fr])
  }

  @Test func switchingToWeeklyStartsOnTheEventsDay() {
    // Wed 18 Nov 2026, noon in New York.
    let start = zone.calendar.date(from: DateComponents(year: 2026, month: 11, day: 18, hour: 12))!.ms
    let weekly = Recurrence(freq: .daily, interval: 3, end: .count(4)).with(freq: .weekly, startMs: start, zone: zone)
    #expect(weekly == Recurrence(freq: .weekly, interval: 3, byWeekday: [.we], end: .count(4)))
    #expect(weekly.with(freq: .monthly, startMs: start, zone: zone).byWeekday.isEmpty)
  }

  @Test func weekOrderFollowsTheUsersFirstDay() {
    #expect(Recurrence.Weekday.ordered(from: .sunday).map(\.rawValue) == ["SU", "MO", "TU", "WE", "TH", "FR", "SA"])
    #expect(Recurrence.Weekday.ordered(from: .monday).first == .mo)
    #expect(Recurrence.Weekday.ordered(from: .saturday).first == .sa)
  }
}
