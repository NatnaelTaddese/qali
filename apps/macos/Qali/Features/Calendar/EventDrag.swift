import AppKit
import Observation
import QaliDomain

/// Direct manipulation of timed event cards, ported from the web's
/// `useEventDrag`: a card is moved whole (across day columns) or has one edge
/// dragged, snapping to the grid's quarter hours (with a trackpad tap at each
/// snap), and on release the new times are saved with `updateEventTime`.
///
/// Both the live preview and the wait for the synced row are overrides on the
/// event list, so the real card is laid out again where it is going (the
/// cards around it reflow too) with no positioning of its own. A failed save
/// drops the override and the card returns.
@Observable
final class EventDrag {
  enum Mode {
    /// The whole event, keeping its length.
    case move
    case resizeStart
    case resizeEnd
  }

  struct Times: Equatable {
    var startMs: Double
    var endMs: Double
  }

  /// Where the strip's day columns are, in the coordinate space the card
  /// gestures report in (`EventDrag.space`, the strip's own).
  struct Geometry {
    var days: [Date]
    /// The columns on screen; a move never lands on a buffered day.
    var visible: Range<Int>
    var column: CGFloat
    var dayHeight: CGFloat
    var zone: WorkingZone
  }

  /// The coordinate space of the strip of day columns.
  static let space = "event-drag-strip"

  /// How long a saved position is held while waiting for the synced row,
  /// before giving up and dropping it anyway.
  private static let pendingTimeout: Duration = .seconds(10)

  private(set) var overrides: [String: Times] = [:]
  /// The card being dragged, drawn lifted.
  private(set) var draggingId: String?

  private struct Session {
    var event: CalendarEvent
    var mode: Mode
    /// From the event's start to the instant under the press (move only).
    var grabOffsetMs: Double
    var durationMs: Double
    var cancelled = false
  }

  @ObservationIgnored private var session: Session?
  /// Ids whose override is a save waiting for the synced row.
  @ObservationIgnored private var pending: Set<String> = []
  @ObservationIgnored private var timeouts: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private var keyMonitor: Any?

  /// `events` with any drag or pending-save overrides applied.
  func apply(to events: [CalendarEvent]) -> [CalendarEvent] {
    guard !overrides.isEmpty else { return events }
    return events.map { event in
      guard let times = overrides[event.id] else { return event }
      var moved = event
      moved.startMs = times.startMs
      moved.endMs = times.endMs
      return moved
    }
  }

  // MARK: Gesture

  /// The press became a drag (the gesture's 4pt threshold was crossed).
  /// `point` is where the press started, in strip coordinates.
  func begin(_ event: CalendarEvent, mode: Mode, at point: CGPoint, in geometry: Geometry) {
    guard session == nil else { return }
    session = Session(
      event: event,
      mode: mode,
      grabOffsetMs: pointerMs(point, in: geometry) - event.startMs,
      durationMs: max(event.endMs - event.startMs, snapMs)
    )
    draggingId = event.id
    // Escape puts the card back and ends the drag; the press itself carries
    // on until the button comes up, and is ignored.
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] key in
      guard key.keyCode == 53, let self, self.session?.cancelled == false else { return key }
      self.cancel()
      return nil
    }
  }

  func move(to point: CGPoint, in geometry: Geometry) {
    guard let session, !session.cancelled else { return }
    let times = times(for: session, at: point, in: geometry)
    let event = session.event
    let previous = overrides[event.id] ?? Times(startMs: event.startMs, endMs: event.endMs)
    if overrides[event.id] != times { overrides[event.id] = times }
    guard times != previous else { return }
    // A tap on the trackpad for each snap the card steps through, firmer
    // when it lands on another day.
    let changedDay = !geometry.zone.isSameDay(Date(ms: previous.startMs), Date(ms: times.startMs))
    feedback(changedDay ? .levelChange : .alignment)
  }

  /// Plays a haptic on a Force Touch trackpad (nothing with a mouse, or
  /// with haptics off in System Settings), unless turned off in Settings ›
  /// General; swapped out by the tests.
  @ObservationIgnored var feedback: (NSHapticFeedbackManager.FeedbackPattern) -> Void = { pattern in
    guard EventDrag.hapticsEnabled else { return }
    NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: .now)
  }

  /// The Settings switch, per Mac; on unless turned off.
  static let hapticsKey = "dragHaptics"
  static var hapticsEnabled: Bool { UserDefaults.standard.object(forKey: hapticsKey) as? Bool ?? true }

  /// The button came up: saves the new times, unless nothing changed.
  func end(at point: CGPoint, in geometry: Geometry, save: @escaping (CalendarEvent, Times) async throws -> Void, failed: @escaping (Error) -> Void) {
    defer { finishSession() }
    guard let session, !session.cancelled else { return }
    let times = times(for: session, at: point, in: geometry)
    let event = session.event
    if times.startMs == event.startMs && times.endMs == event.endMs {
      overrides[event.id] = nil
      return
    }
    overrides[event.id] = times
    hold(event.id)
    Task { @MainActor [weak self] in
      do {
        try await save(event, times)
      } catch {
        self?.release(event.id)
        failed(error)
      }
    }
  }

  /// Drops pending overrides the synced rows have caught up with (or whose
  /// event is gone). The card being dragged is left alone.
  func reconcile(_ events: [CalendarEvent]) {
    guard !pending.isEmpty else { return }
    let byId = Dictionary(events.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    for id in pending {
      guard let times = overrides[id] else {
        pending.remove(id)
        continue
      }
      if let row = byId[id], row.startMs != times.startMs || row.endMs != times.endMs { continue }
      release(id)
    }
  }

  private func cancel() {
    guard let id = session?.event.id else { return }
    session?.cancelled = true
    overrides[id] = nil
    draggingId = nil
  }

  private func finishSession() {
    session = nil
    draggingId = nil
    if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
    keyMonitor = nil
  }

  private func hold(_ id: String) {
    pending.insert(id)
    timeouts[id]?.cancel()
    timeouts[id] = Task { @MainActor [weak self] in
      try? await Task.sleep(for: Self.pendingTimeout)
      guard !Task.isCancelled else { return }
      self?.release(id)
    }
  }

  private func release(_ id: String) {
    pending.remove(id)
    timeouts.removeValue(forKey: id)?.cancel()
    if draggingId != id { overrides[id] = nil }
  }

  // MARK: Geometry

  /// The visible column under `x`, clamped to the page.
  private func columnIndex(_ x: CGFloat, in geometry: Geometry) -> Int {
    let index = Int((x / max(geometry.column, 1)).rounded(.down))
    return min(max(index, geometry.visible.lowerBound), geometry.visible.upperBound - 1)
  }

  /// The instant under a point, unsnapped.
  private func pointerMs(_ point: CGPoint, in geometry: Geometry) -> Double {
    let dayStart = geometry.days[columnIndex(point.x, in: geometry)].ms
    return dayStart + Double(point.y / max(geometry.dayHeight, 1)) * msPerDay
  }

  /// The proposed times for the pointer at `point`.
  private func times(for session: Session, at point: CGPoint, in geometry: Geometry) -> Times {
    let event = session.event
    let fraction = Double(point.y / max(geometry.dayHeight, 1))
    switch session.mode {
    case .move:
      let dayStart = geometry.days[columnIndex(point.x, in: geometry)].ms
      let raw = dayStart + fraction * msPerDay - session.grabOffsetMs
      let start = clamp(snap(raw, dayStart), dayStart, dayStart + msPerDay - session.durationMs)
      return Times(startMs: start, endMs: start + session.durationMs)
    case .resizeStart, .resizeEnd:
      // A resize stays on the event's own day, cut in the working zone like
      // the strip's columns.
      let dayStart = geometry.zone.startOfDay(Date(ms: event.startMs)).ms
      let pointer = clamp(snap(dayStart + fraction * msPerDay, dayStart), dayStart, dayStart + msPerDay)
      if session.mode == .resizeStart {
        return Times(startMs: min(pointer, event.endMs - snapMs), endMs: event.endMs)
      }
      return Times(startMs: event.startMs, endMs: max(pointer, event.startMs + snapMs))
    }
  }

  private func snap(_ ms: Double, _ dayStart: Double) -> Double {
    dayStart + ((ms - dayStart) / snapMs).rounded() * snapMs
  }

  /// The web's `clamp`: the upper bound wins when the two cross.
  private func clamp(_ value: Double, _ low: Double, _ high: Double) -> Double {
    min(max(value, low), high)
  }
}
