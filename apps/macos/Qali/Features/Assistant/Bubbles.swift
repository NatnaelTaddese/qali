import AppKit
import SwiftUI

/// The Messages palette: the sent blue (which Messages keeps whatever the
/// accent colour) and the received grey, in both appearances.
enum BubbleColors {
  static let sent = Color(nsColor: .systemBlue)
  /// Solid, as in Messages, so a reply reads cleanly over the glass.
  static let received = Color(
    nsColor: NSColor(name: "assistantReceived") { appearance in
      appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor(srgbRed: 59 / 255, green: 59 / 255, blue: 61 / 255, alpha: 1)
        : NSColor(srgbRed: 233 / 255, green: 233 / 255, blue: 235 / 255, alpha: 1)
    }
  )
}

/// A Messages bubble: a rounded body with, on the last bubble of a run, the
/// little horn at its bottom corner. The horn always has its gutter beside
/// the body, so bubbles with and without one line up.
nonisolated struct BubbleShape: Shape {
  /// The horn's side: trailing for the user, leading for the assistant.
  var trailing: Bool
  var tail: Bool

  static let tailWidth: CGFloat = 6
  static let radius: CGFloat = 17

  func path(in rect: CGRect) -> Path {
    let w = rect.width
    let h = rect.height
    let tw = Self.tailWidth
    let r = min(Self.radius, h / 2)
    // Drawn with the horn on the right, then mirrored for the left.
    let body = Path(roundedRect: CGRect(x: 0, y: 0, width: w - tw, height: h), cornerRadius: r, style: .continuous)
    var path = body
    if tail {
      let bx = w - tw
      var horn = Path()
      horn.move(to: CGPoint(x: bx - r, y: h))
      // The flat underside runs out to the tip…
      horn.addLine(to: CGPoint(x: w - 1.5, y: h))
      horn.addQuadCurve(to: CGPoint(x: w, y: h - 1.2), control: CGPoint(x: w + 0.4, y: h - 0.2))
      // …and the outer edge sweeps back up into the body's side.
      horn.addCurve(
        to: CGPoint(x: bx, y: h - min(16, h * 0.55)),
        control1: CGPoint(x: bx + 1.5, y: h - 3.5),
        control2: CGPoint(x: bx, y: h - 8)
      )
      horn.addLine(to: CGPoint(x: bx - r, y: h - min(16, h * 0.55)))
      horn.closeSubpath()
      path = body.union(horn)
    }
    guard !trailing else { return path.offsetBy(dx: rect.minX, dy: rect.minY) }
    return path
      .applying(CGAffineTransform(scaleX: -1, y: 1).translatedBy(x: -w, y: 0))
      .offsetBy(dx: rect.minX, dy: rect.minY)
  }
}

/// One bubble of a run. `trailing` puts it on the user's side, in blue.
struct MessageBubble<Content: View>: View {
  var trailing: Bool
  var tail: Bool
  /// The sent blue, dimmed while the message is on its way and red-edged
  /// once it failed.
  var dimmed = false
  @ViewBuilder var content: Content

  var body: some View {
    let shape = BubbleShape(trailing: trailing, tail: tail)
    content
      .font(.sans(TextSize.sm))
      .foregroundStyle(trailing ? Color.white : Palette.foreground)
      .tint(trailing ? Color.white : BubbleColors.sent)
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      // The horn's gutter, kept on every bubble so a run's edges align.
      .padding(trailing ? .trailing : .leading, BubbleShape.tailWidth)
      .background { shape.fill(trailing ? BubbleColors.sent : BubbleColors.received) }
      .opacity(dimmed ? 0.6 : 1)
      .contentShape(shape)
      .textSelection(.enabled)
  }
}

/// The assistant writing: the grey bubble with three dots breathing in turn,
/// as in Messages. Under Reduce Motion the dots hold still.
struct TypingBubble: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
      let t = timeline.date.timeIntervalSinceReferenceDate
      HStack(spacing: 4) {
        ForEach(0..<3, id: \.self) { index in
          let phase = reduceMotion ? 0.5 : Self.phase(t, dot: index)
          Circle()
            .fill(Palette.mutedForeground)
            .frame(width: 7, height: 7)
            .opacity(0.35 + 0.55 * phase)
            .scaleEffect(0.85 + 0.15 * phase)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 11)
      .padding(.leading, BubbleShape.tailWidth)
      .background { BubbleShape(trailing: false, tail: true).fill(BubbleColors.received) }
    }
    .accessibilityElement()
    .accessibilityLabel("Qali is typing")
  }

  /// 0…1 for a dot at time `t`: each peaks a third of a beat after the one
  /// before it, on a 1.2s beat.
  private static func phase(_ t: TimeInterval, dot: Int) -> Double {
    let angle: Double = t * 2 * Double.pi / 1.2 - Double(dot) * 0.9
    return (sin(angle) + 1) / 2
  }
}

/// Qali's face: the web's mascot glyph (apps/web mascot-glyph.tsx), the
/// plump two-curl ghost, as a SwiftUI shape with its eyes knocked out.
nonisolated struct MascotShape: Shape {
  /// The outline only (with solid eyes), for the toolbar at rest.
  var outline = false

  func path(in rect: CGRect) -> Path {
    let scale = min(rect.width, rect.height) / 236
    let transform = CGAffineTransform(translationX: rect.midX - 118 * scale, y: rect.midY - 118 * scale)
      .scaledBy(x: scale, y: scale)
    var body = Path()
    body.move(to: CGPoint(x: 40, y: 118))
    let curves: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
      (36, 66, 74, 30, 122, 32), (172, 34, 202, 74, 196, 122), (193, 147, 181, 158, 176, 176),
      (171, 195, 176, 214, 156, 216), (141, 217, 137, 201, 128, 199), (119, 197, 113, 208, 101, 209),
      (86, 210, 80, 197, 73, 180), (67, 165, 51, 158, 45, 141), (41, 129, 40, 124, 40, 118),
    ]
    for c in curves {
      body.addCurve(to: CGPoint(x: c.4, y: c.5), control1: CGPoint(x: c.0, y: c.1), control2: CGPoint(x: c.2, y: c.3))
    }
    body.closeSubpath()
    var eyes = Path()
    eyes.addRoundedRect(in: CGRect(x: 80, y: 88, width: 28, height: 54), cornerSize: CGSize(width: 14, height: 14))
    eyes.addRoundedRect(in: CGRect(x: 128, y: 92, width: 28, height: 54), cornerSize: CGSize(width: 14, height: 14))
    let shape =
      outline
      ? body.strokedPath(StrokeStyle(lineWidth: 15, lineJoin: .round)).union(eyes)
      : body.subtracting(eyes)
    return shape.applying(transform)
  }
}

/// Qali as a Messages contact photo: the ghost on the chroma gradient.
struct AssistantAvatar: View {
  var size: CGFloat

  var body: some View {
    ZStack {
      LinearGradient(
        colors: [Palette.chroma(1), Palette.chroma(3), Palette.chroma(5)],
        startPoint: .topLeading, endPoint: .bottomTrailing
      )
      MascotShape()
        .fill(.white)
        .padding(size * 0.2)
        .shadow(color: .black.opacity(0.15), radius: size * 0.03, y: size * 0.02)
    }
    .frame(width: size, height: size)
    .clipShape(.circle)
    .overlay { Circle().strokeBorder(.white.opacity(0.12)) }
    .accessibilityHidden(true)
  }
}
