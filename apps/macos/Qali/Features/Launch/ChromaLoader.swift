import SwiftUI

/// The brand loading indicator, ported from the web `ChromaLoader`: a single
/// "Q" in the display face with the chroma band looping across it.
struct ChromaLoader: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// The band repeats every 360pt and travels 720pt in 3s (the web's
  /// `chroma-loop-sweep`), so one period passes the glyph every 1.5s.
  private static let period: CGFloat = 360
  private static let cycle: TimeInterval = 1.5

  var body: some View {
    GeometryReader { proxy in
      // `text-4xl` on small windows, 4vmin once that is larger.
      let size = max(32, min(proxy.size.width, proxy.size.height) * 0.04)
      TimelineView(.animation(paused: reduceMotion)) { timeline in
        let elapsed = timeline.date.timeIntervalSinceReferenceDate
        // Reduced motion parks the band where the glyph reads as plain text.
        let phase = reduceMotion ? 0.5 : elapsed.truncatingRemainder(dividingBy: Self.cycle) / Self.cycle
        glyph(size: size)
          .hidden()
          .overlay(alignment: .leading) {
            band
              .frame(width: Self.period * 3)
              .offset(x: (phase - 1) * Self.period)
          }
          .mask { glyph(size: size) }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .accessibilityElement()
    .accessibilityLabel("Loading")
  }

  /// A wide box, so the glyph in its middle samples a smooth slice of the
  /// sweep rather than the whole band crammed into one letter.
  private func glyph(size: CGFloat) -> some View {
    Text("Q")
      .font(.display(size, .extraBold))
      .frame(width: Self.period)
  }

  /// Three periods of the band, so the visible one is always covered.
  private var band: some View {
    let colors = [Palette.foreground] + (1...5).map(Palette.chroma) + [Palette.foreground]
    let positions: [CGFloat] = [0, 0.2, 0.36, 0.5, 0.64, 0.8, 1]
    let stops = (0..<3).flatMap { repeatIndex in
      zip(colors, positions).map { color, position in
        Gradient.Stop(color: color, location: (CGFloat(repeatIndex) + position) / 3)
      }
    }
    return LinearGradient(stops: stops, startPoint: .leading, endPoint: .trailing)
  }
}
