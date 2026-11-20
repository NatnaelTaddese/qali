import Foundation
import Testing
@testable import QaliDomain

private let london = WorkingZone(identifier: "Europe/London")!
private let tokyo = WorkingZone(identifier: "Asia/Tokyo")!
private let kolkata = WorkingZone(identifier: "Asia/Kolkata")!
private let losAngeles = WorkingZone(identifier: "America/Los_Angeles")!

/// Fri 20 Nov 2026 in New York (EST, UTC−5).
private let friday = midnight(2026, 11, 20, in: newYork)

@Suite struct ZoneRailColumnTests {
  @Test func labelsEachWorkingZoneHourLineInTheOtherZone() {
    let column = zoneRailColumn(day: friday, primary: newYork, other: tokyo, use24h: false)
    #expect(column.labels.count == 23)
    // 1am New York is 3pm in Tokyo; 10am is Tokyo's midnight.
    #expect(column.labels.first == .init(line: 1, text: "3pm"))
    #expect(column.labels[9] == .init(line: 10, text: "12am"))
    #expect(column.labels.last == .init(line: 23, text: "1pm"))
  }

  @Test func twentyFourHourLabelsAndHalfHourZones() {
    let column = zoneRailColumn(day: friday, primary: newYork, other: kolkata, use24h: true)
    // 9am New York is 19:30 in Kolkata (UTC+5:30).
    #expect(column.labels[8].text == "19:30")
    let twelve = zoneRailColumn(day: friday, primary: newYork, other: kolkata, use24h: false)
    #expect(twelve.labels[8].text == "7:30pm")
  }

  @Test func marksWhereANewDayStartsAndWhichWayItRuns() {
    let ahead = zoneRailColumn(day: friday, primary: newYork, other: tokyo, use24h: false)
    #expect(ahead.dayStarts == [.init(hours: 10, dayOffset: 1)])

    let london = zoneRailColumn(day: friday, primary: newYork, other: london, use24h: false)
    #expect(london.dayStarts == [.init(hours: 19, dayOffset: 1)])

    // Los Angeles starts the same calendar day three hours in.
    let behind = zoneRailColumn(day: friday, primary: newYork, other: losAngeles, use24h: false)
    #expect(behind.dayStarts == [.init(hours: 3, dayOffset: 0)])

    let between = zoneRailColumn(day: friday, primary: newYork, other: kolkata, use24h: false)
    #expect(between.dayStarts == [.init(hours: 13.5, dayOffset: 1)])
  }

  @Test func marksWhereMorningAndEveningStartInTheOtherZone() {
    // London's 6am and 6pm are 1am and 1pm in New York.
    let london = zoneRailColumn(day: friday, primary: newYork, other: london, use24h: false)
    #expect(london.daylightEdges == [.init(hours: 1, rises: true), .init(hours: 13, rises: false)])
    // Tokyo's evening starts at 4am; its next morning at 4pm.
    let tokyo = zoneRailColumn(day: friday, primary: newYork, other: tokyo, use24h: false)
    #expect(tokyo.daylightEdges == [.init(hours: 4, rises: false), .init(hours: 16, rises: true)])
    // Kolkata's sit between the hour lines.
    let kolkata = zoneRailColumn(day: friday, primary: newYork, other: kolkata, use24h: false)
    #expect(kolkata.daylightEdges == [.init(hours: 7.5, rises: false), .init(hours: 19.5, rises: true)])
  }

  @Test func theSameZoneLinesUpWithTheWorkingZone() {
    let column = zoneRailColumn(day: friday, primary: newYork, other: newYork, use24h: false)
    #expect(column.labels[16].text == "5pm")
    #expect(column.dayStarts.isEmpty)
  }
}

@Suite struct ZoneOffsetLabelTests {
  @Test func spellsTheDifferenceFromTheWorkingZone() {
    let at = friday.addingTimeInterval(12 * 3600)
    #expect(zoneOffsetLabel(tokyo, from: newYork, at: at) == "+14h")
    #expect(zoneOffsetLabel(losAngeles, from: newYork, at: at) == "−3h")
    #expect(zoneOffsetLabel(kolkata, from: newYork, at: at) == "+10:30")
    #expect(zoneOffsetLabel(newYork, from: newYork, at: at) == "±0h")
  }

  @Test func followsDaylightSaving() {
    // In July New York is on EDT (UTC−4), so London is still five hours on.
    let july = midnight(2026, 7, 1, in: newYork).addingTimeInterval(12 * 3600)
    #expect(zoneOffsetLabel(london, from: newYork, at: july) == "+5h")
    #expect(zoneOffsetLabel(tokyo, from: newYork, at: july) == "+13h")
  }
}

@Suite struct ZoneCodeTests {
  @Test func commonZonesUseWellKnownCityCodes() {
    #expect(zoneCode("America/New_York") == "NYC")
    #expect(zoneCode("Europe/London") == "LDN")
    #expect(zoneCode("Asia/Tokyo") == "TYO")
    #expect(zoneCode("Asia/Kolkata") == "IND")
    #expect(zoneCode("UTC") == "UTC")
  }

  @Test func otherZonesTakeLettersFromTheirCity() {
    #expect(zoneCode("Asia/Kathmandu") == "KAT")
    #expect(zoneCode("Pacific/Port_Moresby") == "PMO")
    #expect(zoneCode("America/Port-au-Prince") == "PAP")
    #expect(zoneCode("America/Bahia_Banderas") == "BBA")
    #expect(zoneCode("Atlantic/Reykjavik") == "REY")
    #expect(zoneCode("America/Asunción") == "ASU")
  }

  @Test func everyKnownIdentifierGetsThreeCapitalLetters() {
    for identifier in TimeZone.knownTimeZoneIdentifiers {
      let code = zoneCode(identifier)
      #expect(code.count == 3, "\(identifier) → \(code)")
      #expect(code == code.uppercased(), "\(identifier) → \(code)")
    }
  }
}

@Suite struct EventTimesInZonesTests {
  /// Tue 17 Nov 2026, 6:30–7:30 PM in New York.
  private let start = midnight(2026, 11, 17, in: newYork).addingTimeInterval(18.5 * 3600).ms
  private var end: Double { start + 3_600_000 }

  @Test func readsTheEventInEachZone() {
    let times = eventTimesInZones(
      startMs: start, endMs: end, zones: [tokyo, london, losAngeles], primary: newYork, use24h: false)
    #expect(times.map(\.code) == ["TYO", "LDN", "LAX"])
    // Tokyo: the next morning, a day on.
    #expect(times[0].time == "8:30 AM – 9:30 AM")
    #expect(times[0].days == "Wed")
    #expect(times[0].isDaytime)
    // London: runs past its midnight.
    #expect(times[1].time == "11:30 PM – 12:30 AM")
    #expect(times[1].days == "Tue → Wed")
    #expect(!times[1].isDaytime)
    // Los Angeles: the same afternoon.
    #expect(times[2].time == "3:30 PM – 4:30 PM")
    #expect(times[2].days == nil)
    #expect(times[2].isDaytime)
  }

  @Test func twentyFourHourClockAndHalfHourZones() {
    let times = eventTimesInZones(startMs: start, endMs: end, zones: [kolkata], primary: newYork, use24h: true)
    #expect(times[0].time == "05:00 – 06:00")
    #expect(times[0].days == "Wed")
    #expect(!times[0].isDaytime)
  }

  @Test func anEventEndingAtMidnightThereStaysOnItsDay() {
    // 6–7 PM New York is 11 PM – midnight in London.
    let six = midnight(2026, 11, 17, in: newYork).addingTimeInterval(18 * 3600).ms
    let times = eventTimesInZones(startMs: six, endMs: six + 3_600_000, zones: [london], primary: newYork, use24h: false)
    #expect(times[0].time == "11:00 PM – 12:00 AM")
    #expect(times[0].days == nil)
  }
}

@Suite struct RailEditTests {
  @Test func makingAZonePrimaryPutsTheWorkingZoneInItsSlot() {
    let rail = ["Asia/Tokyo", "Europe/London"]
    #expect(zonesAfterMakingPrimary(rail, other: "Europe/London", working: "Asia/Shanghai") == ["Asia/Tokyo", "Asia/Shanghai"])
    #expect(zonesAfterMakingPrimary(rail, other: "Asia/Tokyo", working: "Asia/Shanghai") == ["Asia/Shanghai", "Europe/London"])
    // Never twice, should the working zone already be on the rail.
    #expect(zonesAfterMakingPrimary(rail, other: "Asia/Tokyo", working: "Europe/London") == ["Europe/London"])
  }

  @Test func movingHoldsAtTheEnds() {
    let rail = ["Asia/Tokyo", "Europe/London"]
    #expect(zonesMoving(rail, "Europe/London", by: -1) == ["Europe/London", "Asia/Tokyo"])
    #expect(zonesMoving(rail, "Asia/Tokyo", by: 1) == ["Europe/London", "Asia/Tokyo"])
    #expect(zonesMoving(rail, "Asia/Tokyo", by: -1) == rail)
    #expect(zonesMoving(rail, "Pacific/Fiji", by: 1) == rail)
  }

  @Test func offsetsInWords() {
    let at = friday.addingTimeInterval(12 * 3600)
    #expect(zoneOffsetPhrase(tokyo, from: newYork, at: at) == "14 hours ahead")
    #expect(zoneOffsetPhrase(losAngeles, from: newYork, at: at) == "3 hours behind")
    #expect(zoneOffsetPhrase(kolkata, from: newYork, at: at) == "10.5 hours ahead")
    #expect(zoneOffsetPhrase(newYork, from: newYork, at: at) == "Same time")
    #expect(zoneOffsetPhrase(WorkingZone(identifier: "America/Chicago")!, from: newYork, at: at) == "1 hour behind")
  }
}
