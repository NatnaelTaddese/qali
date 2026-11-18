import AppKit
import Observation
import SwiftUI

/// Horizontal scrolling for the time grid, the web time strip's
/// `scroll-snap-type: x mandatory` on a trackpad.
///
/// A two-finger swipe moves the day columns continuously; letting go glides on
/// the swipe's speed and springs onto the nearest day boundary. The strip is
/// drawn around the navigation anchor (its leftmost day) and shifted by
/// `offset`. Whenever the offset passes half a column the anchor moves a day
/// and the offset gives that day back, so the strip never runs out of
/// columns, the toolbar title follows the scroll, and `offset` always stays
/// within half a column of zero.
///
/// A swipe that sets off clearly along one axis is locked to it, so a
/// vertical scroll doesn't wobble the days and a sideways one doesn't drift
/// the hours. One that sets off diagonally, or that strays far enough off its
/// axis, moves both: the sideways part drives the strip and the rest goes on
/// to the hour grid's scroll view.
@Observable
final class StripScroller {
  /// How far the strip is scrolled past its anchor, in points; positive shows
  /// later days.
  private(set) var offset: CGFloat = 0

  /// The width of one day column.
  @ObservationIgnored var columnWidth: CGFloat = 1 {
    didSet { if columnWidth != oldValue { reset() } }
  }
  /// Off in month view, where the time grid is hidden.
  @ObservationIgnored var isEnabled = true {
    didSet { if !isEnabled { reset() } }
  }
  /// The farthest one fling may travel, in days.
  @ObservationIgnored var maxFlingDays = 14
  /// Moves the anchor by whole days.
  @ObservationIgnored var shiftAnchor: (Int) -> Void = { _ in }
  /// Runs and pauses the frame clock that drives the landing spring.
  @ObservationIgnored var setAnimating: (Bool) -> Void = { _ in }

  /// True from when the strip starts moving (a swipe, a glide, a step) until
  /// it lands on a day.
  private(set) var isMoving = false

  // MARK: Tuning

  /// Seconds of glide a release's velocity is worth: how far momentum
  /// carries the strip before it snaps to a day.
  private static let glideSeconds: CGFloat = 0.2
  /// How much more one axis must lead the other, on the first movement, for
  /// the swipe to lock to it.
  private static let lockRatio: CGFloat = 2
  /// How far a locked swipe may stray across its axis before both move.
  private static let unlockTravel: CGFloat = 24
  /// A release this fast moves at least one day, however short its glide.
  private static let flingVelocity: CGFloat = 300
  /// The landing spring's natural frequency (a 0.35 s response). It is
  /// critically damped, so starting at the swipe's own velocity it slows
  /// into the day without a bounce.
  private static let omega: CGFloat = 2 * .pi / 0.35

  // MARK: State

  private enum Axis {
    case undecided, horizontal, vertical
    /// Both: the strip takes the sideways movement, the hours the rest.
    case free
  }

  @ObservationIgnored private var axis: Axis = .undecided
  /// Days the anchor has moved since the gesture began, in points, so
  /// velocity samples stay on one continuous axis across re-anchoring.
  @ObservationIgnored private var base: CGFloat = 0
  @ObservationIgnored private var samples: [(time: TimeInterval, position: CGFloat)] = []
  /// Movement across the locked axis since the swipe began.
  @ObservationIgnored private var crossTravel: CGFloat = 0
  /// Where the landing spring is heading, relative to the current anchor.
  @ObservationIgnored private var target: CGFloat?
  @ObservationIgnored private var velocity: CGFloat = 0
  /// The anchor this scroller last moved to: any other anchor change came
  /// from the toolbar or a shortcut, and starts the strip afresh.
  @ObservationIgnored var ownAnchor: Date?

  // MARK: Events

  /// Handles a scroll-wheel event inside the grid. Returns the event to
  /// dispatch on, or nil to drop it.
  func handle(_ event: NSEvent) -> NSEvent? {
    guard isEnabled else { return event }
    guard event.hasPreciseScrollingDeltas else { return handleWheel(event) }

    // Resting fingers catch a glide in flight, like any scroll view.
    if event.phase.contains(.mayBegin) {
      stopSpring()
      return event
    }
    if event.phase.contains(.began) {
      stopSpring()
      axis = .undecided
      base = 0
      samples = []
      crossTravel = 0
    }

    // Momentum after the fingers lift: the strip has already planned its
    // landing, so it only keeps the hour grid from scrolling on it.
    // A free swipe's vertical momentum still carries the hours.
    if !event.momentumPhase.isEmpty {
      switch axis {
      case .horizontal: return Self.withoutDeltas(event)
      case .free: return Self.verticalOnly(event)
      case .vertical, .undecided: return event
      }
    }

    let dx = event.scrollingDeltaX, dy = event.scrollingDeltaY
    switch axis {
    case .undecided where dx != 0 || dy != 0:
      if abs(dx) > Self.lockRatio * abs(dy) {
        axis = .horizontal
      } else if abs(dy) > Self.lockRatio * abs(dx) {
        axis = .vertical
      } else {
        axis = .free
      }
    case .horizontal, .vertical:
      crossTravel += abs(axis == .horizontal ? dy : dx)
      if crossTravel > Self.unlockTravel { axis = .free }
    default:
      break
    }
    if axis == .horizontal || axis == .free, !isMoving, !(event.phase.contains(.ended) || event.phase.contains(.cancelled)) {
      isMoving = true
    }
    guard axis == .horizontal || axis == .free else {
      if event.phase.contains(.ended) || event.phase.contains(.cancelled) { settleIfNeeded() }
      return event
    }

    if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
      release(velocity: velocity(at: event.timestamp))
    } else {
      // Natural scrolling is already in the deltas: content follows them.
      move(by: -event.scrollingDeltaX, at: event.timestamp)
    }
    // The phase still reaches the scroll view, so its own gesture tracking
    // begins and ends cleanly: with the vertical movement on a free swipe,
    // with none on a sideways one.
    return axis == .free ? Self.verticalOnly(event) : Self.withoutDeltas(event)
  }

  /// A mouse wheel (Shift turns it sideways) steps a day per notch.
  private func handleWheel(_ event: NSEvent) -> NSEvent? {
    let dx = event.scrollingDeltaX
    guard dx != 0, abs(dx) > abs(event.scrollingDeltaY) else { return event }
    step(days: dx > 0 ? -1 : 1)
    return nil
  }

  /// Glides `days` days on with the landing spring, from wherever the strip
  /// is already heading, so steps in quick succession add up instead of
  /// cutting each other short. The toolbar arrows, arrow keys and wheel
  /// notches move this way.
  func step(days: Int) {
    guard isEnabled, days != 0 else { return }
    let from = target ?? (offset / columnWidth).rounded() * columnWidth
    startSpring(to: from + CGFloat(days) * columnWidth, velocity: velocity)
  }

  /// Glides until the day `days` after the current anchor is the leftmost,
  /// keeping any motion already under way.
  func glide(toDay days: Int) {
    guard isEnabled else { return }
    startSpring(to: CGFloat(days) * columnWidth, velocity: velocity)
  }

  // MARK: Moving

  private func move(by delta: CGFloat, at time: TimeInterval) {
    setOffset(offset + delta)
    samples.append((time, base + offset))
    samples.removeAll { time - $0.time > 0.1 }
  }

  /// The swipe's speed over its last tenth of a second, in points per
  /// second. Fingers that stopped before lifting have none.
  private func velocity(at time: TimeInterval) -> CGFloat {
    let recent = samples.filter { time - $0.time <= 0.1 }
    guard let first = recent.first, let last = recent.last, last.time > first.time else { return 0 }
    return (last.position - first.position) / CGFloat(last.time - first.time)
  }

  /// Lands the strip on a day: where the glide would end, rounded to a
  /// column, and at least the next day over for a quick flick.
  private func release(velocity: CGFloat) {
    let column = columnWidth
    let nearest = (offset / column).rounded()
    var days = ((offset + velocity * Self.glideSeconds) / column).rounded()
    if days == nearest, abs(velocity) > Self.flingVelocity {
      days = nearest + (velocity > 0 ? 1 : -1)
    }
    let limit = CGFloat(maxFlingDays)
    days = min(max(days, -limit), limit)
    startSpring(to: days * column, velocity: velocity)
  }

  private func settleIfNeeded() {
    guard target == nil else { return }
    if offset != 0 {
      startSpring(to: (offset / columnWidth).rounded() * columnWidth, velocity: 0)
    } else if isMoving {
      isMoving = false
    }
  }

  /// Moves the strip, handing whole days over to the anchor.
  private func setOffset(_ value: CGFloat) {
    var value = value
    let days = (value / columnWidth).rounded()
    if days != 0 {
      value -= days * columnWidth
      target? -= days * columnWidth
      base += days * columnWidth
      shiftAnchor(Int(days))
    }
    offset = value
  }

  // MARK: Spring

  private func startSpring(to destination: CGFloat, velocity: CGFloat) {
    isMoving = true
    target = destination
    self.velocity = velocity
    setAnimating(true)
  }

  private func stopSpring() {
    guard target != nil else { return }
    target = nil
    velocity = 0
    setAnimating(false)
  }

  /// Advances the landing spring by `dt` seconds: the closed-form critically
  /// damped step, so a long frame cannot make it unstable.
  func tick(_ dt: CGFloat) {
    guard let target else { return setAnimating(false) }
    let w = Self.omega
    let x0 = offset - target
    let c = velocity + w * x0
    let decay = exp(-w * dt)
    let x = (x0 + c * dt) * decay
    velocity = (velocity - w * c * dt) * decay
    if abs(x) < 0.25, abs(velocity) < 8 {
      setOffset(target)
      self.target = nil
      velocity = 0
      setAnimating(false)
      isMoving = false
    } else {
      setOffset(target + x)
    }
  }

  /// Drops any scroll in progress: the page changed under the strip.
  func reset() {
    target = nil
    velocity = 0
    axis = .undecided
    base = 0
    samples = []
    crossTravel = 0
    if offset != 0 { offset = 0 }
    setAnimating(false)
    if isMoving { isMoving = false }
  }

  #if DEBUG
    /// Lets the strip go at `velocity` points per second, as a real release
    /// would, for `-QaliFling` captures.
    func debugFling(_ velocity: CGFloat) { release(velocity: velocity) }
  #endif

  // MARK: Helpers

  /// The same event with no scroll movement, phases intact.
  private static func withoutDeltas(_ event: NSEvent) -> NSEvent? {
    zeroing(event, vertical: true)
  }

  /// The same event with its sideways movement taken out (axis 2 is
  /// horizontal, axis 1 vertical).
  private static func verticalOnly(_ event: NSEvent) -> NSEvent? {
    zeroing(event, vertical: false)
  }

  private static func zeroing(_ event: NSEvent, vertical: Bool) -> NSEvent? {
    guard let copy = event.cgEvent?.copy() else { return nil }
    var integers: [CGEventField] = [.scrollWheelEventDeltaAxis2, .scrollWheelEventPointDeltaAxis2]
    var doubles: [CGEventField] = [.scrollWheelEventFixedPtDeltaAxis2]
    if vertical {
      integers += [.scrollWheelEventDeltaAxis1, .scrollWheelEventPointDeltaAxis1]
      doubles.append(.scrollWheelEventFixedPtDeltaAxis1)
    }
    for field in integers { copy.setIntegerValueField(field, value: 0) }
    for field in doubles { copy.setDoubleValueField(field, value: 0) }
    return NSEvent(cgEvent: copy)
  }
}

/// Feeds the strip the scroll-wheel events that land inside it, and runs its
/// landing spring on the display's frame clock. Placed behind the time grid,
/// it sees events before the hour grid's scroll view does, through a local
/// event monitor bounded to its own frame.
struct StripScrollCatcher: NSViewRepresentable {
  let scroller: StripScroller

  func makeNSView(context: Context) -> CatcherView {
    let view = CatcherView()
    view.scroller = scroller
    return view
  }

  func updateNSView(_ view: CatcherView, context: Context) {
    view.scroller = scroller
  }

  static func dismantleNSView(_ view: CatcherView, coordinator: ()) {
    view.stop()
  }

  final class CatcherView: NSView {
    var scroller: StripScroller? {
      didSet {
        scroller?.setAnimating = { [weak self] running in self?.setRunning(running) }
      }
    }

    private var monitor: Any?
    private var link: CADisplayLink?
    private var lastFrame: CFTimeInterval?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      stop()
      guard window != nil else { return }
      // Local monitors run on the main thread, inside `NSApp.sendEvent`.
      monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
        guard let self, let scroller = self.scroller, event.window === self.window else { return event }
        let point = self.convert(event.locationInWindow, from: nil)
        guard self.bounds.contains(point) else { return event }
        return scroller.handle(event)
      }
    }

    func stop() {
      if let monitor { NSEvent.removeMonitor(monitor) }
      monitor = nil
      link?.invalidate()
      link = nil
    }

    private func setRunning(_ running: Bool) {
      if running {
        if link == nil {
          let link = displayLink(target: self, selector: #selector(frame(_:)))
          link.add(to: .main, forMode: .common)
          self.link = link
        }
        lastFrame = nil
        link?.isPaused = false
      } else {
        link?.isPaused = true
      }
    }

    @objc private func frame(_ link: CADisplayLink) {
      let now = link.timestamp
      let dt = lastFrame.map { min(now - $0, 1.0 / 30) } ?? 1.0 / 120
      lastFrame = now
      scroller?.tick(CGFloat(dt))
    }
  }
}
