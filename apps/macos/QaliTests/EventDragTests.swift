import AppKit
import Foundation
import QaliDomain
import Testing
@testable import Qali

/// Dragging a card taps the trackpad as it picks up, once per step it
/// reaches, and more firmly when it changes day.
@MainActor
struct EventDragTests {
  let zone = WorkingZone(identifier: "Europe/Berlin")!
  /// Wed 18 Nov 2026, 10:00–11:00 in Berlin.
  let start = 1_795_510_800_000.0

  /// Two day columns 100pt wide, 40pt to the hour (a quarter hour is 10pt).
  private var geometry: EventDrag.Geometry {
    let wednesday = zone.startOfDay(Date(ms: start))
    return EventDrag.Geometry(
      days: [wednesday, zone.addingDays(1, to: wednesday)],
      visible: 0..<2,
      column: 100,
      dayHeight: 960,
      zone: zone
    )
  }

  @Test func tapsOncePerSnapAndFirmerAcrossDays() {
    let drag = EventDrag()
    var taps: [DragHaptics.Moment] = []
    drag.feedback = { taps.append($0) }
    let event = CalendarEvent(id: "e1", startMs: start, endMs: start + 3_600_000, allDay: false, status: "confirmed")

    // Grabbed at its 10:00 top edge.
    drag.begin(event, mode: .move, at: CGPoint(x: 50, y: 400), in: geometry)
    drag.move(to: CGPoint(x: 50, y: 401), in: geometry)
    #expect(taps == [.pickUp], "still on its own slot")

    drag.move(to: CGPoint(x: 50, y: 410), in: geometry)
    drag.move(to: CGPoint(x: 50, y: 412), in: geometry)
    #expect(taps == [.pickUp, .snap], "one tap for 10:15, none within it")

    drag.move(to: CGPoint(x: 150, y: 412), in: geometry)
    #expect(taps == [.pickUp, .snap, .day], "Thursday is another day")
  }

  @Test func resizingTapsEachStep() {
    let drag = EventDrag()
    var taps: [DragHaptics.Moment] = []
    drag.feedback = { taps.append($0) }
    let event = CalendarEvent(id: "e1", startMs: start, endMs: start + 3_600_000, allDay: false, status: "confirmed")

    // The bottom edge, 11:00, out to 11:30.
    drag.begin(event, mode: .resizeEnd, at: CGPoint(x: 50, y: 440), in: geometry)
    drag.move(to: CGPoint(x: 50, y: 450), in: geometry)
    drag.move(to: CGPoint(x: 50, y: 460), in: geometry)
    #expect(taps == [.pickUp, .resize, .resize])
  }

  @Test func longerStepsTapOnTheirBoundariesBothWays() {
    let drag = EventDrag()
    var taps: [DragHaptics.Moment] = []
    drag.feedback = { taps.append($0) }
    drag.tuning = {
      var tuning = DragHaptics.Tuning()
      tuning.stepMinutes = 30
      return tuning
    }
    let event = CalendarEvent(id: "e1", startMs: start, endMs: start + 3_600_000, allDay: false, status: "confirmed")

    drag.begin(event, mode: .move, at: CGPoint(x: 50, y: 400), in: geometry)
    drag.move(to: CGPoint(x: 50, y: 410), in: geometry)  // 10:15
    #expect(taps == [.pickUp])
    drag.move(to: CGPoint(x: 50, y: 420), in: geometry)  // 10:30
    #expect(taps == [.pickUp, .snap])
    drag.move(to: CGPoint(x: 50, y: 410), in: geometry)  // back to 10:15
    #expect(taps == [.pickUp, .snap], "leaving a boundary isn't reaching one")
    drag.move(to: CGPoint(x: 50, y: 400), in: geometry)  // 10:00
    drag.move(to: CGPoint(x: 50, y: 440), in: geometry)  // jumps to 11:00, past 10:30
    #expect(taps == [.pickUp, .snap, .snap, .snap])
  }
}
