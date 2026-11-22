import SwiftUI

/// Notifications that arrive while the calendar has the user's attention,
/// as glass cards stacked under the toolbar's bell. Each one grows out of
/// the bell as it arrives and shrinks back into it as it leaves, Liquid Glass
/// style (see `MorphingToast`). A click opens the item as the feed does;
/// each card leaves on its own after a while, waiting while the pointer is
/// on it.
struct NotificationToasts: View {
  let notifier: Notifier
  let open: (NotificationRow) -> Void

  static let cardSize = CGSize(width: 320, height: 54)
  /// The toolbar's glass circle around the bell.
  static let bellDiameter: CGFloat = 36

  var body: some View {
    GeometryReader { proxy in
      let bell = bellCenter(in: proxy)
      // Newest first, under the bell.
      let rows = Array(notifier.toasts.reversed())
      // Closer than the 8pt between cards, so stacked cards stay apart.
      GlassEffectContainer(spacing: 4) {
        ZStack(alignment: .topLeading) {
          ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
            MorphingToast(
              row: row,
              detail: notifier.detail(row),
              bell: bell,
              slot: slot(index, bell: bell, width: proxy.size.width),
              leaving: notifier.leaving.contains(row.id)
            ) {
              open(row)
              notifier.dismissToast(row)
            } dismiss: {
              notifier.dismissToast(row)
            }
          }
        }
        .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
      }
    }
    // Under the toolbar too, where the bell is.
    .ignoresSafeArea()
  }

  /// The bell's centre in this view; until the toolbar reports it, where it
  /// sits in a standard window.
  private func bellCenter(in proxy: GeometryProxy) -> CGPoint {
    let origin = proxy.frame(in: .global).origin
    guard let frame = notifier.bellFrame else { return CGPoint(x: proxy.size.width - 34, y: 26) }
    return CGPoint(x: frame.midX - origin.x, y: frame.midY - origin.y)
  }

  /// A card's centre: right-aligned with the bell's glass, stacked below it.
  private func slot(_ index: Int, bell: CGPoint, width: CGFloat) -> CGPoint {
    let size = Self.cardSize
    let right = min(bell.x + Self.bellDiameter / 2, width - 8)
    let top = bell.y + Self.bellDiameter / 2 + 12 + CGFloat(index) * (size.height + 8)
    return CGPoint(x: max(right - size.width / 2, size.width / 2 + 8), y: top + size.height / 2)
  }
}

/// One toast: a single piece of glass that starts as a bubble the size of
/// the bell's, right under it (the toolbar draws over the content), and
/// grows into the card as it arrives; leaving, it shrinks back into the bell.
/// The glass bends as its shape changes, so it reads as flowing out of the
/// bell rather than fading in. The words fade in once there's room for them.
private struct MorphingToast: View {
  let row: NotificationRow
  let detail: String?
  let bell: CGPoint
  let slot: CGPoint
  let leaving: Bool
  let open: () -> Void
  let dismiss: () -> Void

  @State private var expanded = false
  /// The blur under the card, only once its glass has settled: it is not
  /// glass, so it would show its shape before the glass got there.
  @State private var settled = false
  @State private var hovering = false
  /// Inactive while another app or window is in front.
  @Environment(\.controlActiveState) private var activeState
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var morph: Animation {
    reduceMotion ? .easeOut(duration: 0.2) : .bouncy(duration: Notifier.morphSeconds, extraBounce: 0.06)
  }

  /// Long enough to read and reach for; a reminder stays as long as the
  /// web's toast does.
  private var lifetime: Duration { row.type == "booking_requested" ? .seconds(12) : .seconds(30) }

  var body: some View {
    let card = NotificationToasts.cardSize
    let bubble = NotificationToasts.bellDiameter
    // With Reduce Motion the card keeps its shape and place and only fades.
    let grown = expanded || reduceMotion
    let size = grown ? card : CGSize(width: bubble, height: bubble)
    let shape = RoundedRectangle(cornerRadius: grown ? 22 : bubble / 2, style: .continuous)

    ToastContent(row: row, detail: detail)
      .frame(width: card.width, height: card.height)
      // The words come in as the glass makes room, and go first on the way
      // back; with Reduce Motion the whole card just fades.
      .opacity(grown ? 1 : 0)
      .blur(radius: grown ? 0 : 6)
      .frame(width: size.width, height: size.height)
      .clipShape(shape)
      .contentShape(shape)
      .glassEffect(.regular.interactive(), in: shape)
      // A blur under the glass, as macOS puts under the toolbar's pills, so
      // the grid doesn't bend through the words.
      .background {
        shape.fill(.ultraThinMaterial).opacity(settled ? 1 : 0)
      }
      .overlay(alignment: .topLeading) {
        // The close button sits on the corner, as on the system's banners.
        if hovering && expanded {
          Button(action: dismiss) {
            Image(systemName: "xmark")
              .font(.system(size: 8, weight: .bold))
              .foregroundStyle(Palette.foreground)
              .frame(width: 18, height: 18)
              .contentShape(.circle)
          }
          .buttonStyle(.plain)
          .glassEffect(.regular.interactive(), in: .circle)
          .offset(x: -4, y: -4)
          .transition(.opacity)
          .accessibilityLabel("Dismiss")
          .help("Dismiss")
        }
      }
      .opacity(reduceMotion && !expanded ? 0 : 1)
      .position(grown ? slot : bell)
      .allowsHitTesting(expanded)
      .onHover { inside in withAnimation(.easeOut(duration: 0.12)) { hovering = inside } }
      .onTapGesture(perform: open)
      .animation(.smooth(duration: 0.35), value: slot)
      .task {
        // One frame as the bubble, so there is a shape to grow from.
        try? await Task.sleep(for: .milliseconds(30))
        withAnimation(morph) { expanded = true }
        try? await Task.sleep(for: .seconds(Notifier.morphSeconds * 0.8))
        withAnimation(.easeOut(duration: 0.2)) { settled = true }
      }
      .onChange(of: leaving) { _, leaving in
        guard leaving else { return }
        // The blur goes first: it can't follow the glass back into the bell.
        settled = false
        hovering = false
        withAnimation(morph) { expanded = false }
      }
      // Restarts whenever the pointer leaves, so a card being read stays,
      // and only runs while the window is in front: one that arrived while
      // the user was away (Only in qali) is still there when they come back.
      .task(id: [hovering, activeState == .inactive, leaving]) {
        guard !hovering, !leaving, activeState != .inactive else { return }
        try? await Task.sleep(for: lifetime)
        guard !Task.isCancelled else { return }
        dismiss()
      }
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isButton)
      .accessibilityAction(named: "Dismiss", dismiss)
      .help("Open")
  }
}

/// What a card says: an icon for the kind, the title, the time, and "now".
private struct ToastContent: View {
  let row: NotificationRow
  let detail: String?

  private var isBooking: Bool { row.type == "booking_requested" }

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: isBooking ? "person.crop.circle.badge.plus" : "alarm.fill")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: 30, height: 30)
        .background((isBooking ? Color.green : Color.orange).gradient, in: .circle)
      VStack(alignment: .leading, spacing: 2) {
        Text(row.title)
          .font(.sans(TextSize.sm, .medium))
          .foregroundStyle(Palette.foreground)
        if let detail {
          Text(detail)
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
        }
      }
      .lineLimit(1)
      Spacer(minLength: 0)
      Text("now")
        .font(.sans(TextSize.xs))
        .foregroundStyle(Palette.mutedForeground.opacity(0.8))
    }
    .padding(.leading, 10)
    .padding(.trailing, 16)
  }
}
