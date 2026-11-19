import SwiftUI

/// The chosen segment's raised thumb, as a Mac segmented control draws it:
/// white with a soft shadow in light mode, a translucent lift with a hairline
/// edge in dark mode. The app's switches (RSVP, Where) draw their own
/// segments, because a stock segmented control outside the toolbar takes the
/// blue system accent, and slide this thumb between them.
struct SegmentThumb: View {
  var cornerRadius: CGFloat = 7
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    let dark = scheme == .dark
    shape
      .fill(dark ? Color.white.opacity(0.16) : .white)
      .overlay { shape.strokeBorder(.white.opacity(dark ? 0.08 : 0), lineWidth: 0.5) }
      .shadow(color: .black.opacity(dark ? 0.25 : 0.12), radius: 1, y: 0.5)
  }
}
