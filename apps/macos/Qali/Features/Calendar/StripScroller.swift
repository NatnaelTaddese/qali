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
  /// Scrolls up and down instead (the month grid's week rows, with
  /// `columnWidth` the row height): every swipe drives it, whatever its
  /// direction, since nothing under it scrolls.
  @ObservationIgnored var vertical = false
  /// How far past the anchor, in steps, the strip runs before handing whole
  /// steps over to it. Half a step for the time grid; the month draws spare
  /// weeks either side and hands over several at once, since every hand-over
  /// rebuilds its grid. Whatever is left is handed over on landing.
  @ObservationIgnored var handOver: CGFloat = 0.5
  /// The farthest one fling may travel, in days.
  @ObservationIgnored var maxFlingDays = 14
  /// Moves the anchor by whole days.
  @ObservationIgnored var shiftAnchor: (Int) -> Void = { _ in }
  /// Runs and pauses the frame clock that drives the landing spring.
  @ObservationIgnored var setAnimating: (Bool) -> Void = { _ in }

  /// Whole steps past the anchor the strip shows (its offset, rounded).
  /// Changes only when a step boundary is crossed.
  private(set) var visibleSteps = 0
  /// Told `visibleSteps` as it changes, straight after any hand-over in the
  /// same step, so whoever names the page in view never sees the anchor
  /// moved without the steps given back.
  @ObservationIgnored var reportVisibleSteps: (Int) -> Void = { _ in }

  /// True from when the strip starts moving (a swipe, a glide, a step) until
  /// it lands on a day.
  private(set) var isMoving = false {
    didSet { if isMoving != oldValue { reportMoving(isMoving) } }
  }
  /// Told when `isMoving` changes, straight away rather than through a
  /// view's `onChange`, which would tie that view to it.
  @ObservationIgnored var reportMoving: (Bool) -> Void = { _ in }

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
  /// The finger's path: where it had moved the strip (`base` + offset) and
  /// when, by the events' own timestamps.
  @ObservationIgnored private var samples: [(time: TimeInterval, position: CGFloat)] = []
  /// Movement across the locked axis since the swipe began.
  @ObservationIgnored private var crossTravel: CGFloat = 0
  /// Where the landing spring is heading, relative to the current anchor.
  @ObservationIgnored private var target: CGFloat?
  @ObservationIgnored private var velocity: CGFloat = 0
  /// Where the finger has moved the strip to (`base` + offset), while one
  /// is on the trackpad. A trackpad reports at its own pace, out of step
  /// with the display, so drawing each event as it comes would move some
  /// frames twice as far as others. Instead each frame draws the finger's
  /// path as it was a moment before that frame is shown, read between the
  /// events either side, so the strip moves evenly, as a scroll view does.
  @ObservationIgnored private var finger: CGFloat?
  /// How far behind its display time a frame reads the finger's path:
  /// about one trackpad report, so there is nearly always an event after.
  private static let fingerLag: TimeInterval = 0.012
  /// The anchor this scroller last moved to: any other anchor change came
  /// from the toolbar or a shortcut, and starts the strip afresh.
  @ObservationIgnored var ownAnchor: Date?

  // MARK: Events

  /// Handles a scroll-wheel event inside the grid. Returns the event to
  /// dispatch on, or nil to drop it.
  func handle(_ event: NSEvent) -> NSEvent? {
    guard isEnabled else { return event }
    if vertical { return handleVertical(event) }
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
      finger = nil
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
      release(velocity: velocity(at: Self.time(of: event)))
    } else {
      // Natural scrolling is already in the deltas: content follows them.
      move(by: -event.scrollingDeltaX, at: Self.time(of: event))
    }
    // The phase still reaches the scroll view, so its own gesture tracking
    // begins and ends cleanly: with the vertical movement on a free swipe,
    // with none on a sideways one.
    return axis == .free ? Self.verticalOnly(event) : Self.withoutDeltas(event)
  }

  /// The vertical mode's whole handling: the swipe moves the rows, its
  /// momentum is replaced by the landing glide, and a wheel notch steps a
  /// row. Nothing is passed on.
  private func handleVertical(_ event: NSEvent) -> NSEvent? {
    let dy = event.scrollingDeltaY
    guard event.hasPreciseScrollingDeltas else {
      if dy != 0, abs(dy) >= abs(event.scrollingDeltaX) { step(days: dy > 0 ? -1 : 1) }
      return nil
    }
    guard event.momentumPhase.isEmpty else { return nil }
    if event.phase.contains(.mayBegin) {
      stopSpring()
      return nil
    }
    if event.phase.contains(.began) {
      stopSpring()
      base = 0
      samples = []
      finger = nil
      isMoving = true
    }
    if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
      if isMoving { release(velocity: velocity(at: Self.time(of: event))) }
    } else if dy != 0 {
      isMoving = true
      move(by: -dy, at: Self.time(of: event))
    }
    return nil
  }

  /// Whole steps ahead of the anchor where the strip is heading: its landing
  /// spot while it glides, else where it rests.
  var heading: Int { Int(((target ?? offset) / columnWidth).rounded()) }

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
    if finger == nil {
      // Where the strip was, a report before the first movement.
      let start = base + offset
      finger = start
      samples = [(time - Self.fingerLag, start)]
    }
    finger! += delta
    samples.append((time, finger!))
    samples.removeAll { time - $0.time > 0.2 }
    setAnimating(true)
  }

  /// The finger's path at `time`: between the reports either side, or the
  /// nearest end.
  private func fingerPosition(at time: TimeInterval) -> CGFloat? {
    guard let last = samples.last, let first = samples.first else { return finger }
    if time >= last.time { return last.position }
    if time <= first.time { return first.position }
    guard let after = samples.firstIndex(where: { $0.time >= time }), after > 0 else { return last.position }
    let a = samples[after - 1], b = samples[after]
    let span = b.time - a.time
    guard span > 0 else { return b.position }
    return a.position + (b.position - a.position) * CGFloat((time - a.time) / span)
  }

  /// The finger has let go: the strip carries on from where it is drawn.
  private func endFinger() {
    finger = nil
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
    endFinger()
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
    endFinger()
    if offset != 0 {
      startSpring(to: (offset / columnWidth).rounded() * columnWidth, velocity: 0)
    } else if isMoving {
      isMoving = false
    }
  }

  /// Moves the strip, handing whole days over to the anchor.
  private func setOffset(_ value: CGFloat, landing: Bool = false) {
    var value = value
    let steps = value / columnWidth
    let days = landing || abs(steps) > handOver ? steps.rounded() : 0
    if days != 0 {
      value -= days * columnWidth
      target? -= days * columnWidth
      base += days * columnWidth
      shiftAnchor(Int(days))
    }
    // Every set notifies, and the strip redraws for it.
    if offset != value { offset = value }
    let visible = Int((value / columnWidth).rounded())
    if visible != visibleSteps {
      visibleSteps = visible
      reportVisibleSteps(visible)
    }
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
    if finger == nil { setAnimating(false) }
  }

  /// Draws the frame to be shown at `time`: the finger's path while one is
  /// down, else the landing spring advanced by `dt` seconds (the
  /// closed-form critically damped step, so a long frame cannot make it
  /// unstable).
  func tick(_ dt: CGFloat, at time: TimeInterval) {
    if let finger {
      let read = time - Self.fingerLag
      if let position = fingerPosition(at: read) { setOffset(position - base) }
      // Caught up with a finger resting on the trackpad: rest the clock
      // until it moves again.
      if let last = samples.last, read - last.time > 0.1, abs(base + offset - finger) < 0.01 { setAnimating(false) }
      return
    }
    guard let target else { return setAnimating(false) }
    let w = Self.omega
    let x0 = offset - target
    let c = velocity + w * x0
    let decay = exp(-w * dt)
    let x = (x0 + c * dt) * decay
    velocity = (velocity - w * c * dt) * decay
    if abs(x) < 0.25, abs(velocity) < 8 {
      setOffset(target, landing: true)
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
    finger = nil
    if offset != 0 { offset = 0 }
    if visibleSteps != 0 {
      visibleSteps = 0
      reportVisibleSteps(0)
    }
    setAnimating(false)
    if isMoving { isMoving = false }
  }

  #if DEBUG
    /// Lets the strip go at `velocity` points per second, as a real release
    /// would, for `-QaliFling` captures.
    func debugFling(_ velocity: CGFloat) { release(velocity: velocity) }
  #endif

  // MARK: Helpers

  /// When the event happened, on the display clock the frames are timed
  /// by. Both count from boot; an event without a believable timestamp is
  /// taken as happening now.
  private static func time(of event: NSEvent) -> TimeInterval {
    let now = CACurrentMediaTime()
    let stamp = event.timestamp
    #if DEBUG
      if UserDefaults.standard.bool(forKey: "QaliFrameLog") { print(String(format: "CLOCK event lag %.2f ms", (now - stamp) * 1000)) }
    #endif
    return stamp > 0 && abs(now - stamp) < 1 ? stamp : now
  }

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

/// What a scrolling track draws, skipped when only the scroll moved.
///
/// A track re-renders on every scroll frame to move its content, and in
/// doing so hands the content over again. SwiftUI can't tell that content
/// (cells and cards built by closures) is unchanged, so without this it
/// would re-diff and re-lay-out every cell or card each frame, a cost that
/// grows with the events on screen. `render` is made fresh each time the
/// grid around the track renders, so the content updates then and only
/// then; what it observes itself still updates it.
struct ScrollContent<Content: View>: View, Equatable {
  final class Render {}

  let render: Render
  let content: Content

  var body: some View { content }

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.render === rhs.render }
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
    #if DEBUG
      private var meter: FrameMeter?
    #endif

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      stop()
      guard window != nil else { return }
      // Local monitors run on the main thread, inside `NSApp.sendEvent`.
      monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
        guard let self, let scroller = self.scroller, self.takes(event) else { return event }
        return scroller.handle(event)
      }
      #if DEBUG
        if let script = UserDefaults.standard.string(forKey: "QaliSwipe") { DebugSwipe.run(script, in: self) }
        if UserDefaults.standard.bool(forKey: "QaliFrameLog"), !FrameMeter.running { meter = FrameMeter(view: self) }
      #endif
    }

    /// A scroll the strip should take: over this grid, in its window, and
    /// not over a panel floating on it (which scrolls itself).
    func takes(_ event: NSEvent) -> Bool {
      guard let window, event.window === window else { return false }
      guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return false }
      return !ScrollShield.covers(event.locationInWindow, in: window)
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
      scroller?.tick(CGFloat(dt), at: link.targetTimestamp)
    }
  }
}

/// Panels floating over the calendar grid (the assistant) whose scrolls are
/// their own. The grid takes scroll-wheel events through a window-wide
/// monitor, ahead of any view, so without this a scroll over a panel moved
/// the grid behind it.
@MainActor
enum ScrollShield {
  /// Each panel's frame in SwiftUI's global space (the window's content,
  /// measured down from the top), by name.
  static var rects: [String: CGRect] = [:]

  static func covers(_ pointInWindow: NSPoint, in window: NSWindow) -> Bool {
    guard let content = window.contentView, !rects.isEmpty else { return false }
    let point = CGPoint(x: pointInWindow.x, y: content.bounds.height - pointInWindow.y)
    return rects.values.contains { $0.contains(point) }
  }
}

extension View {
  /// Keeps the grid's scrolling out of this view's frame while it's shown.
  func shieldsScrolls(_ name: String) -> some View {
    onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { ScrollShield.rects[name] = $0 }
      .onDisappear { ScrollShield.rects[name] = nil }
  }
}

#if DEBUG
  /// `-QaliFrameLog YES` prints, every half second the display ticks, how
  /// many frames the main thread missed: a callback arriving more than one
  /// refresh after the last means the run loop was busy through a vsync.
  final class FrameMeter: NSObject {
    static var running = false
    private var link: CADisplayLink?
    private var last: CFTimeInterval?
    private var frames = 0, missed = 0, worst = 0.0
    private var windowStart: CFTimeInterval = 0

    init(view: NSView) {
      super.init()
      Self.running = true
      let link = view.displayLink(target: self, selector: #selector(tick(_:)))
      link.add(to: .main, forMode: .common)
      self.link = link
    }

    @objc private func tick(_ link: CADisplayLink) {
      let now = link.timestamp
      let period = max(link.targetTimestamp - link.timestamp, 1.0 / 240)
      if let last {
        let gap = now - last
        frames += 1
        missed += max(Int((gap / period).rounded()) - 1, 0)
        worst = max(worst, gap)
      } else {
        windowStart = now
      }
      last = now
      if now - windowStart >= 0.5 {
        print(String(format: "FRAMES t=%.1f frames=%d missed=%d worst=%.1fms", now, frames, missed, worst * 1000))
        frames = 0; missed = 0; worst = 0; windowStart = now
      }
    }
  }

  /// `-QaliSwipe @600,0` (or `@0,-900`, or several `dx,dy` pairs joined by `;`)
  /// plays trackpad swipes over the view three seconds after launch: a
  /// quarter second of finger movement covering that many points, then the
  /// momentum a real flick leaves. The events are delivered inside the app,
  /// never posted to the system, so they reach only this window.
  enum DebugSwipe {
    static func run(_ script: String, in view: NSView) {
      // A leading `@` keeps a negative first number from reading as a flag.
      // `f2400` instead of a pair lets the strip go at that speed, as a
      // release would: the glide runs on the display clock, so it is the
      // steadiest way to time frames.
      let steps = script.trimmingCharacters(in: CharacterSet(charactersIn: "@ ")).split(separator: ";").map(String.init)
      Task { @MainActor [weak view] in
        let delay = UserDefaults.standard.double(forKey: "QaliSwipeDelay")
        try? await Task.sleep(for: .seconds(delay > 0 ? delay : 3))
        for step in steps {
          guard let view, let scroller = (view as? StripScrollCatcher.CatcherView)?.scroller, scroller.isEnabled else { return }
          if step.hasPrefix("f"), let velocity = Double(step.dropFirst()) {
            scroller.debugFling(velocity)
            try? await Task.sleep(for: .milliseconds(1200))
            continue
          }
          let pair = step.split(separator: ",").compactMap { Double($0) }
          guard pair.count == 2 else { continue }
          await play(dx: pair[0], dy: pair[1], over: view)
          try? await Task.sleep(for: .milliseconds(600))
        }
      }
    }

    @MainActor private static func play(dx: Double, dy: Double, over view: NSView) async {
      guard let window = view.window, let screen = window.screen else { return }
      // Each grid has a catcher; only the one whose grid is showing plays.
      guard (view as? StripScrollCatcher.CatcherView)?.scroller?.isEnabled == true else { return }
      let local = NSPoint(x: view.bounds.midX, y: view.bounds.midY)
      let inWindow = view.convert(local, to: nil)
      let onScreen = window.convertPoint(toScreen: inWindow)
      // CGEvent locations are measured down from the primary screen's top.
      let primary = NSScreen.screens.first?.frame.height ?? screen.frame.height
      let location = CGPoint(x: onScreen.x, y: primary - onScreen.y)
      func send(_ x: Double, _ y: Double, phase: Int64, momentum: Int64) {
        guard let event = CGEvent(
          scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
          wheel1: Int32(y.rounded()), wheel2: Int32(x.rounded()), wheel3: 0
        ) else { return }
        event.location = location
        // Stamped like a real event: nanoseconds of uptime.
        event.timestamp = CGEventTimestamp(clock_gettime_nsec_np(CLOCK_UPTIME_RAW))
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        event.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(y.rounded()))
        event.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(x.rounded()))
        event.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: y)
        event.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: x)
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
        event.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
        guard let ns = NSEvent(cgEvent: event) else { return }
        // A window-less event skips the app's monitors and hit testing, so
        // both are done here as `sendEvent` would: the strip first, then
        // the view under the point (which hands it up to its scroll view).
        let routed: NSEvent? = (view as? StripScrollCatcher.CatcherView)?.scroller.map { $0.handle(ns) } ?? ns
        if let routed { window.contentView?.hitTest(inWindow)?.scrollWheel(with: routed) }
      }
      let tick: Duration = .microseconds(8333)
      let steps = 30
      send(0, 0, phase: 128, momentum: 0)
      send(0, 0, phase: 1, momentum: 0)
      for _ in 0..<steps {
        // A trackpad reports near the display's rate but not in step with it.
        try? await Task.sleep(for: .microseconds(Int.random(in: 6000...11000)))
        send(dx / Double(steps), dy / Double(steps), phase: 2, momentum: 0)
      }
      send(0, 0, phase: 4, momentum: 0)
      // Momentum: the last speed, decaying.
      var vx = dx / Double(steps), vy = dy / Double(steps)
      send(vx, vy, phase: 0, momentum: 1)
      while abs(vx) > 0.5 || abs(vy) > 0.5 {
        try? await Task.sleep(for: tick)
        vx *= 0.95; vy *= 0.95
        send(vx, vy, phase: 0, momentum: 2)
      }
      send(0, 0, phase: 0, momentum: 3)
    }
  }
#endif
