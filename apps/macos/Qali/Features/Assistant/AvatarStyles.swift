import SwiftUI

/// The landing page's mascot (apps/www mascot.tsx), drawn natively: a white
/// ghost with a bold outline, glossy capsule eyes in the chroma gradient, a
/// sheen on its crown.
/// Everything is laid out in the mascot's own 236-unit box.
struct MascotFigure: View {
  var size: CGFloat
  var fill: Color = .white
  /// Nil draws no outline.
  var outline: Color? = Color(red: 0.11, green: 0.09, blue: 0.15)
  var sheen = true

  private var unit: CGFloat { size / 236 }

  var body: some View {
    ZStack {
      MascotPath.body.fill(fill)
      if let outline {
        MascotPath.body.stroke(outline, style: StrokeStyle(lineWidth: 9 * unit, lineJoin: .round))
      }
      if sheen {
        MascotPath.sheen
          .stroke(.white.opacity(0.7), style: StrokeStyle(lineWidth: 4 * unit, lineCap: .round))
      }
      MascotPath.eyes.fill(Self.chroma)
        .shadow(color: Color(red: 0.11, green: 0.07, blue: 0.2).opacity(0.25), radius: 2 * unit, y: 2 * unit)
      MascotPath.eyeGloss.fill(
        LinearGradient(
          stops: [.init(color: .white.opacity(0.85), location: 0), .init(color: .white.opacity(0), location: 1)],
          startPoint: .top, endPoint: .bottom))
    }
    .frame(width: size, height: size)
  }

  /// The landing page's eye gradient, corner to corner across both eyes.
  static let chroma = LinearGradient(
    colors: [Palette.chroma(1), Palette.chroma(2), Palette.chroma(3), Palette.chroma(4), Palette.chroma(5)],
    startPoint: UnitPoint(x: 0.32, y: 0.36), endPoint: UnitPoint(x: 0.68, y: 0.64))
}

/// The mascot's parts as shapes in its 236-unit box, scaled to the frame.
enum MascotPath {
  static let body = Part { path in
    path.move(to: CGPoint(x: 40, y: 118))
    let curves: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
      (36, 66, 74, 30, 122, 32), (172, 34, 202, 74, 196, 122), (193, 147, 181, 158, 176, 176),
      (171, 195, 176, 214, 156, 216), (141, 217, 137, 201, 128, 199), (119, 197, 113, 208, 101, 209),
      (86, 210, 80, 197, 73, 180), (67, 165, 51, 158, 45, 141), (41, 129, 40, 124, 40, 118),
    ]
    for c in curves {
      path.addCurve(to: CGPoint(x: c.4, y: c.5), control1: CGPoint(x: c.0, y: c.1), control2: CGPoint(x: c.2, y: c.3))
    }
    path.closeSubpath()
  }
  static let eyes = Part { path in
    path.addRoundedRect(in: CGRect(x: 79, y: 86, width: 30, height: 56), cornerSize: CGSize(width: 15, height: 15))
    path.addRoundedRect(in: CGRect(x: 127, y: 90, width: 30, height: 56), cornerSize: CGSize(width: 15, height: 15))
  }
  static let eyeGloss = Part { path in
    path.addRoundedRect(in: CGRect(x: 84, y: 91, width: 20, height: 34), cornerSize: CGSize(width: 10, height: 10))
    path.addRoundedRect(in: CGRect(x: 132, y: 95, width: 20, height: 34), cornerSize: CGSize(width: 10, height: 10))
  }
  static let sheen = Part { path in
    path.move(to: CGPoint(x: 62, y: 96))
    path.addCurve(to: CGPoint(x: 140, y: 50), control1: CGPoint(x: 74, y: 60), control2: CGPoint(x: 104, y: 46))
  }

  nonisolated struct Part: Shape {
    let draw: @Sendable (inout Path) -> Void

    init(_ draw: @escaping @Sendable (inout Path) -> Void) { self.draw = draw }

    func path(in rect: CGRect) -> Path {
      var path = Path()
      draw(&path)
      let scale = min(rect.width, rect.height) / 236
      return path.applying(
        CGAffineTransform(translationX: rect.midX - 118 * scale, y: rect.midY - 118 * scale)
          .scaledBy(x: scale, y: scale))
    }
  }
}

/// The photos Qali can wear, chosen in Settings › General. Sticker, the
/// landing page's mascot on soft grey, is the default.
enum AvatarStyle: String, CaseIterable, Identifiable {
  case sticker, grey, ink

  var id: String { rawValue }

  /// Where the choice is kept (this Mac's defaults, like the theme).
  static let key = "assistantAvatar"

  var name: String {
    switch self {
    case .sticker: "Sticker"
    case .grey: "Grey"
    case .ink: "Ink"
    }
  }

  var note: String {
    switch self {
    case .sticker: "The landing mascot on soft grey"
    case .grey: "Apple's contact grey, plain white ghost"
    case .ink: "Monochrome: flips with light and dark"
    }
  }
}

/// Qali as a Messages contact photo, in the style chosen in Settings (or a
/// given one, for the picker's previews).
struct AssistantAvatar: View {
  var size: CGFloat
  var style: AvatarStyle?
  @AppStorage(AvatarStyle.key) private var stored = AvatarStyle.sticker.rawValue

  private var resolved: AvatarStyle { style ?? AvatarStyle(rawValue: stored) ?? .sticker }

  var body: some View {
    ZStack {
      background
      figure
    }
    .frame(width: size, height: size)
    .clipShape(.circle)
    .overlay { Circle().strokeBorder(.primary.opacity(0.08), lineWidth: 0.5) }
    .accessibilityHidden(true)
  }

  @ViewBuilder private var background: some View {
    switch resolved {
    case .sticker:
      LinearGradient(colors: [Color(white: 0.96), Color(white: 0.86)], startPoint: .top, endPoint: .bottom)
    case .grey:
      // Apple's default contact-photo gradient.
      LinearGradient(
        colors: [Color(red: 0.66, green: 0.68, blue: 0.73), Color(red: 0.52, green: 0.54, blue: 0.59)],
        startPoint: .top, endPoint: .bottom)
    case .ink:
      Palette.foreground
    }
  }

  @ViewBuilder private var figure: some View {
    switch resolved {
    case .sticker:
      MascotFigure(size: size * 0.78)
        .offset(y: -size * 0.015)
        .shadow(color: .black.opacity(0.12), radius: size * 0.03, y: size * 0.02)
    case .grey:
      MascotFigure(size: size * 0.86, outline: nil, sheen: false)
    case .ink:
      MascotFigure(size: size * 0.86, fill: Palette.background, outline: nil, sheen: false)
    }
  }
}

#if DEBUG
  /// `-QaliAvatarGallery YES`: every photo style at the contact card's,
  /// the header's and a small size, in light and dark side by side.
  struct AvatarGallery: View {
    var body: some View {
      HStack(spacing: 0) {
        sheet(.light)
        sheet(.dark)
      }
    }

    private func sheet(_ scheme: ColorScheme) -> some View {
      VStack(alignment: .leading, spacing: 14) {
        ForEach(AvatarStyle.allCases) { style in
          HStack(spacing: 22) {
            VStack(alignment: .leading, spacing: 2) {
              Text(style.name)
                .font(.sans(TextSize.base, .semibold))
              Text(style.note)
                .font(.sans(TextSize.xs))
                .foregroundStyle(Palette.mutedForeground)
            }
            .frame(width: 210, alignment: .leading)
            AssistantAvatar(size: 72, style: style)
            VStack(spacing: 3) {
              AssistantAvatar(size: 38, style: style)
              Text("Qali ›").font(.sans(TextSize.xs, .medium))
            }
            AssistantAvatar(size: 22, style: style)
          }
        }
      }
      .foregroundStyle(Palette.foreground)
      .padding(28)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(Palette.background)
      .environment(\.colorScheme, scheme)
    }
  }
#endif
