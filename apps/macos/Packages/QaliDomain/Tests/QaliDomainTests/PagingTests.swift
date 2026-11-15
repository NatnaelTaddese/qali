import Foundation
import Testing
@testable import QaliDomain

// Port of paging.test.ts, across zones (the TS suite used runner-local dates).

@Suite struct StripGeometryTests {
  @Test func sideBufferStaysDerivedFromThePerViewPageBuffer() {
    #expect(stripSideDays(.week) == viewBuffer(.week) * viewColumns(.week))
    #expect(stripSideDays(.day) == viewBuffer(.day) * viewColumns(.day))
  }

  @Test(arguments: testZones)
  func stripDaysAreConsecutiveMidnights(zone: WorkingZone) {
    let days = stripDays(anchor: midnight(2026, 3, 5, in: zone), columns: 7, side: 3, zone: zone)
    #expect(days.count == 13)
    for (a, b) in zip(days, days.dropFirst()) {
      #expect(zone.format(b, "HH:mm") == "00:00")
      #expect(zone.calendar.dateComponents([.day], from: a, to: b).day == 1)
    }
  }
}

@Suite struct EventQueryRangeTests {
  private func stripRange(_ anchor: Date, _ columns: Int, _ side: Int, _ zone: WorkingZone) -> (Double, Double) {
    let days = stripDays(anchor: anchor, columns: columns, side: side, zone: zone)
    return (days.first!.ms, days.last!.ms + msPerDay)
  }

  private func renderedRange(_ view: CalendarView, _ anchor: Date, _ zone: WorkingZone) -> (Double, Double) {
    if view == .month {
      let buffer = viewBuffer(.month)
      let first = pageDays(.month, addPages(.month, anchor, -buffer, zone: zone), zone: zone)
      let last = pageDays(.month, addPages(.month, anchor, buffer, zone: zone), zone: zone)
      return (first.first!.ms, last.last!.ms + msPerDay)
    }
    return stripRange(anchor, viewColumns(view), stripSideDays(view), zone)
  }

  @Test(arguments: [CalendarView.day, .week], testZones)
  func windowCoversEveryStripReachableInOneSettle(view: CalendarView, zone: WorkingZone) {
    let maxDelta = stripSideDays(view)
    for dayOffset in 0..<7 {
      let anchor = midnight(2026, 1, 5 + dayOffset, in: zone)
      let window = eventQueryRange(view, anchor: anchor, zone: zone)
      for delta in -maxDelta...maxDelta {
        let rendered = renderedRange(view, midnight(2026, 1, 5 + dayOffset + delta, in: zone), zone)
        #expect(window.startMs <= rendered.0)
        #expect(window.endMs >= rendered.1)
      }
    }
  }

  @Test(arguments: testZones)
  func weekWindowCoversTheNative3ColumnStripWithA6DaySideBuffer(zone: WorkingZone) {
    for dayOffset in 0..<7 {
      let window = eventQueryRange(.week, anchor: midnight(2026, 1, 5 + dayOffset, in: zone), zone: zone)
      for delta in -6...6 {
        let rendered = stripRange(midnight(2026, 1, 5 + dayOffset + delta, in: zone), 3, 6, zone)
        #expect(window.startMs <= rendered.0)
        #expect(window.endMs >= rendered.1)
      }
    }
  }

  @Test(arguments: testZones)
  func monthWindowCoversEveryPageReachableInOneSettle(zone: WorkingZone) {
    let maxDelta = viewBuffer(.month)
    for monthOffset in 0..<12 {
      let anchor = pageStart(.month, midnight(2026, 1 + monthOffset, 1, in: zone), zone: zone)
      let window = eventQueryRange(.month, anchor: anchor, zone: zone)
      for delta in -maxDelta...maxDelta {
        let rendered = renderedRange(.month, addPages(.month, anchor, delta, zone: zone), zone)
        #expect(window.startMs <= rendered.0)
        #expect(window.endMs >= rendered.1)
      }
    }
  }

  @Test(arguments: testZones)
  func windowIsStableWhileTheAnchorStaysInsideItsPeriod(zone: WorkingZone) {
    let monday = pageStart(.week, midnight(2026, 1, 7, in: zone), zone: zone)
    let base = eventQueryRange(.week, anchor: monday, zone: zone)
    for i in 1..<7 {
      #expect(eventQueryRange(.week, anchor: zone.addingDays(i, to: monday), zone: zone) == base)
    }
  }

  @Test func weekStartsOnMovesTheQuantizationBoundary() {
    let wednesday = midnight(2026, 1, 7, in: newYork)
    #expect(newYork.format(pageStart(.week, wednesday, weekStartsOn: .monday, zone: newYork), "EEE d") == "Mon 5")
    #expect(newYork.format(pageStart(.week, wednesday, weekStartsOn: .sunday, zone: newYork), "EEE d") == "Sun 4")
    #expect(newYork.format(pageStart(.week, wednesday, weekStartsOn: .saturday, zone: newYork), "EEE d") == "Sat 3")
  }
}

@Suite struct TitleTests {
  @Test func spanTitleNamesOneOrTwoMonths() {
    let z = newYork
    #expect(spanTitle(midnight(2026, 9, 1, in: z), midnight(2026, 9, 3, in: z), zone: z) == "September 2026")
    #expect(spanTitle(midnight(2026, 9, 30, in: z), midnight(2026, 10, 2, in: z), zone: z) == "Sep – Oct 2026")
    #expect(spanTitle(midnight(2026, 12, 31, in: z), midnight(2027, 1, 2, in: z), zone: z) == "Dec 2026 – Jan 2027")
  }

  @Test func viewTitlePerView() {
    let z = newYork
    let start = midnight(2026, 1, 5, in: z)
    #expect(viewTitle(.day, start, zone: z) == "Monday, Jan 5, 2026")
    #expect(viewTitle(.month, start, zone: z) == "January 2026")
    #expect(viewTitle(.week, start, zone: z) == "January 2026")
  }
}
