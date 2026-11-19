import SwiftUI

/// Something the calendar has been asked to reach for (the web's `Reveal`):
/// `id` is the target's key (an event id, or a day key in month view);
/// `nonce` goes up on every reveal so the same target can flash again; `at`
/// says when, so a card that only mounts afterwards knows whether it is
/// still fresh enough to play.
struct Reveal: Equatable {
  var id: String?
  var nonce = 0
  var at = Date.distantPast

  static let none = Reveal()

  /// How long after a reveal a freshly mounted matching card still flashes:
  /// long enough for a jump's new page to draw, short enough that scrolling
  /// a long-settled target back into view stays quiet.
  static let freshFor: TimeInterval = 4
}

extension EnvironmentValues {
  /// The active reveal, set by the grids for their cards and cells.
  @Entry var reveal = Reveal.none
}

extension View {
  /// Softly double-pulses a primary tint over this view when the active
  /// reveal targets any of `ids` (the web's `RevealFlash`, REVEAL_FLASH
  /// timing). Skipped with Reduce Motion.
  func revealFlash(_ ids: [String], in shape: some Shape = Rectangle(), strength: Double = 0.45) -> some View {
    modifier(RevealFlash(ids: ids, shape: shape, strength: strength))
  }
}

private struct RevealFlash<S: Shape>: ViewModifier {
  let ids: [String]
  let shape: S
  let strength: Double

  @Environment(\.reveal) private var reveal
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var opacity = 0.0
  /// The last nonce this view played; below any real one, so a mount that
  /// matches a fresh reveal plays once.
  @State private var lastPlayed = -1
  @State private var mounted = false

  func body(content: Content) -> some View {
    // -1 when this view is not the target: it never matches `lastPlayed`.
    let active = reveal.id.map(ids.contains) == true ? reveal.nonce : -1
    content
      // Only while it plays: an invisible overlay on every card and cell
      // would still be carried along each frame of a scroll. Coming and
      // going in the pulse's own animation, it fades as an opacity would.
      .overlay {
        if opacity > 0 {
          shape.fill(Palette.primary.opacity(strength))
            .opacity(opacity)
            .allowsHitTesting(false)
        }
      }
      .task(id: active) { await play(active) }
  }

  private func play(_ active: Int) async {
    let isMount = !mounted
    mounted = true
    guard active >= 0, active != lastPlayed else { return }
    lastPlayed = active
    // On (re)mount only a reveal issued just now plays.
    if isMount, Date.now.timeIntervalSince(reveal.at) > Reveal.freshFor { return }
    guard !reduceMotion else { return }
    opacity = 0
    // Keyframes 0 → 1 → 0 → 1 → 0 at 0, .18, .42, .6, 1 of one second,
    // after a 0.3s beat, eased out.
    let steps: [(to: Double, seconds: Double)] = [(1, 0.18), (0, 0.24), (1, 0.18), (0, 0.4)]
    do {
      try await Task.sleep(for: .seconds(0.3))
      for step in steps {
        withAnimation(.easeOut(duration: step.seconds)) { opacity = step.to }
        try await Task.sleep(for: .seconds(step.seconds))
      }
    } catch {
      opacity = 0
    }
  }
}
