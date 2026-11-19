import SwiftUI

/// The faint calendar time-grid behind account-less screens, ported from the
/// web `CalendarBackdrop`: 64pt hour rows from the top and 200pt day columns
/// anchored to the window's centre, in the border colour at 55%, faded toward
/// the edges, with a few sample events resting on the grid.
struct CalendarBackdrop: View {
  /// Overlays the sample events; without them it is the bare grid.
  var ghosts = true

  fileprivate static let column: CGFloat = 200
  fileprivate static let row: CGFloat = 64
  /// Inset that keeps a sample event inside its cell, off the lines.
  fileprivate static let cellGap: CGFloat = 4
  /// Below this width a centred card leaves no room beside it (the web's `sm`).
  private static let ghostMinWidth: CGFloat = 640

  var body: some View {
    GeometryReader { proxy in
      let size = proxy.size
      ZStack(alignment: .topLeading) {
        grid.mask { fade(in: size) }
        if ghosts, size.width >= Self.ghostMinWidth {
          ForEach(GhostEvent.samples) { ghost in
            GhostEventCard(ghost: ghost)
              .frame(
                width: Self.column - 2 * Self.cellGap,
                height: CGFloat(ghost.rowSpan) * Self.row - 2 * Self.cellGap
              )
              .offset(
                x: size.width / 2 + CGFloat(ghost.column) * Self.column + Self.cellGap,
                y: CGFloat(ghost.row) * Self.row + Self.cellGap
              )
          }
        }
      }
      .frame(width: size.width, height: size.height, alignment: .topLeading)
      .clipped()
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  private var grid: some View {
    Canvas { context, size in
      var path = Path()
      var y: CGFloat = 0.5
      while y < size.height {
        path.move(to: CGPoint(x: 0, y: y))
        path.addLine(to: CGPoint(x: size.width, y: y))
        y += Self.row
      }
      // Day lines are anchored to the centre, so a card centred in the window
      // lands between two of them.
      var x = (size.width / 2).truncatingRemainder(dividingBy: Self.column) + 0.5
      while x < size.width {
        path.move(to: CGPoint(x: x, y: 0))
        path.addLine(to: CGPoint(x: x, y: size.height))
        x += Self.column
      }
      context.stroke(path, with: .color(Palette.border.opacity(0.55)), lineWidth: 1)
    }
  }

  /// `radial-gradient(120% 100% at 50% 45%, black 35%, transparent 92%)`: an
  /// ellipse with radii of 1.2 widths and 1 height, centred a little above the
  /// middle.
  private func fade(in size: CGSize) -> some View {
    EllipticalGradient(
      stops: [.init(color: .black, location: 0.35), .init(color: .clear, location: 0.92)],
      center: .center,
      startRadiusFraction: 0,
      endRadiusFraction: 0.5
    )
    .frame(width: size.width * 2.4, height: size.height * 2)
    .position(x: size.width * 0.5, y: size.height * 0.45)
  }
}

/// A sample event snapped to the grid. `column` counts day columns from the
/// window's centre (negative is left); `row` counts hour rows from the top.
///
/// The web hangs these three columns out on the left and four on the right,
/// which suits a browser's width. A window is narrower, so here both sides sit
/// one empty column away from the card (which covers columns -1 and 0).
private struct GhostEvent: Identifiable {
  let hue: Int
  let title: String
  let time: String
  let column: Int
  let row: Int
  let rowSpan: Int

  var id: String { title }

  static let samples = [
    GhostEvent(hue: 4, title: "Standup", time: "9:00 – 9:15 AM", column: -3, row: 1, rowSpan: 1),
    GhostEvent(hue: 6, title: "Deep work", time: "10:00 – 12:00 PM", column: -3, row: 5, rowSpan: 2),
    GhostEvent(hue: 5, title: "1:1", time: "4:00 – 4:30 PM", column: -3, row: 10, rowSpan: 1),
    GhostEvent(hue: 8, title: "Lunch", time: "12:30 – 1:30 PM", column: 2, row: 2, rowSpan: 1),
    GhostEvent(hue: 2, title: "Design review", time: "2:00 – 3:00 PM", column: 2, row: 7, rowSpan: 2),
  ]
}

/// The calendar's event-card recipe (tinted fill, left accent pill) at reduced
/// opacity.
private struct GhostEventCard: View {
  let ghost: GhostEvent

  private let shape = RoundedRectangle(cornerRadius: 9, style: .continuous)

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(ghost.title)
        .font(.sans(TextSize.sm, .medium))
      Text(ghost.time)
        .font(.sans(TextSize.xs))
        .foregroundStyle(Palette.mutedForeground)
    }
    .lineLimit(1)
    .padding(EdgeInsets(top: 5, leading: 12, bottom: 4, trailing: 8))
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background {
      Palette.card
      Palette.event(ghost.hue).opacity(0.22)
    }
    .overlay(alignment: .leading) {
      Capsule()
        .fill(Palette.event(ghost.hue))
        .frame(width: 3)
        .padding(.vertical, 4)
        .padding(.leading, 4)
    }
    .clipShape(shape)
    .overlay { shape.strokeBorder(.primary.opacity(0.1)) }
    .shadow(color: .black.opacity(0.06), radius: 1.5, y: 1)
    .opacity(0.55)
  }
}
