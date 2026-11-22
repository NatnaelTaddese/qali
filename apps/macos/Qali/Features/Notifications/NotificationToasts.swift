import SwiftUI

/// Notifications that arrive while the calendar has the user's attention,
/// stacked under the toolbar's trailing edge where the bell is, as glass
/// cards. A click opens the item as the feed does; each card leaves on its
/// own after a while, waiting while the pointer is on it.
struct NotificationToasts: View {
  let notifier: Notifier
  let open: (NotificationRow) -> Void

  var body: some View {
    VStack(alignment: .trailing, spacing: 8) {
      ForEach(notifier.toasts.reversed()) { row in
        NotificationToast(row: row, detail: notifier.detail(row)) {
          open(row)
          notifier.dismissToast(row)
        } dismiss: {
          notifier.dismissToast(row)
        }
        .transition(.move(edge: .top).combined(with: .opacity).combined(with: .scale(0.96, anchor: .top)))
      }
    }
    .padding(.top, 10)
    .padding(.trailing, 12)
    .animation(.snappy(duration: 0.3), value: notifier.toasts.map(\.id))
  }
}

private struct NotificationToast: View {
  let row: NotificationRow
  let detail: String?
  let open: () -> Void
  let dismiss: () -> Void

  @State private var hovering = false
  /// Inactive while another app or window is in front.
  @Environment(\.controlActiveState) private var activeState

  /// Long enough to read and reach for; a reminder stays as long as the
  /// web's toast does.
  private var lifetime: Duration { row.type == "booking_requested" ? .seconds(12) : .seconds(30) }

  private var isBooking: Bool { row.type == "booking_requested" }

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: isBooking ? "person.crop.circle.badge.plus" : "alarm.fill")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: 30, height: 30)
        .background((isBooking ? Color.green : Color.orange).gradient, in: .rect(cornerRadius: 8, style: .continuous))
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
    .padding(.trailing, 14)
    .padding(.vertical, 10)
    .frame(width: 320)
    .contentShape(.rect(cornerRadius: 16, style: .continuous))
    // Tinted with the window's background, so the grid under it doesn't
    // read through the words.
    .glassEffect(
      .regular.tint(Palette.background.opacity(0.6)).interactive(),
      in: .rect(cornerRadius: 16, style: .continuous))
    // The close button sits on the corner, as on the system's banners.
    .overlay(alignment: .topLeading) {
      if hovering {
        Button(action: dismiss) {
          Image(systemName: "xmark")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(Palette.foreground)
            .frame(width: 18, height: 18)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .offset(x: -6, y: -6)
        .transition(.opacity)
        .accessibilityLabel("Dismiss")
        .help("Dismiss")
      }
    }
    .onHover { inside in withAnimation(.easeOut(duration: 0.12)) { hovering = inside } }
    .onTapGesture(perform: open)
    // Restarts whenever the pointer leaves, so a card being read stays,
    // and only runs while the window is in front: one that arrived while
    // the user was away (Only in qali) is still there when they come back.
    .task(id: [hovering, activeState == .inactive]) {
      guard !hovering, activeState != .inactive else { return }
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
