import SwiftUI

/// The island at rest (the web's `NavRow`): sync, search, create and the
/// booking link, then the account.
struct IslandNavRow: View {
  let island: Island
  let data: CalendarData
  let create: () -> Void

  var body: some View {
    HStack(spacing: 4) {
      IslandNavButton(
        symbol: "calendar",
        label: data.isSyncing ? "Syncing calendar" : "Sync calendar",
        active: true,
        busy: data.isSyncing
      ) {
        Task { await data.syncNow() }
      }
      IslandNavButton(symbol: "magnifyingglass", label: "Search (⌘K)") {
        island.open(.search)
      }
      IslandNavButton(symbol: "plus", label: "New event (⌘N)", action: create)
      let pending = data.booking.pending.count
      IslandNavButton(
        symbol: "calendar.badge.clock",
        label: pending == 0 ? "Booking link" : "Booking link, \(pending) pending",
        badge: pending
      ) {
        island.open(.booking)
      }

      Palette.border
        .frame(width: 1, height: 22)
        .padding(.horizontal, 4)

      Button {
        island.open(.account)
      } label: {
        UserAvatar(size: 30)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Account")
      .help("Account")
    }
  }
}

/// A nav row button: a glyph that picks up a soft fill on hover. The first one
/// carries that fill at rest and rounds into the pill's end, as on the web.
private struct IslandNavButton: View {
  let symbol: String
  let label: String
  var active = false
  var busy = false
  /// A count drawn over the glyph's corner; nothing at zero.
  var badge = 0
  /// Nil for something not built yet: drawn dim and inert.
  let action: (() -> Void)?

  @State private var hovering = false

  var body: some View {
    Button {
      action?()
    } label: {
      Group {
        if busy {
          ProgressView().controlSize(.small)
        } else {
          Image(systemName: symbol)
            .font(.system(size: 15, weight: .medium))
        }
      }
      .foregroundStyle(active || hovering ? Palette.foreground : Palette.mutedForeground)
      .frame(width: 34, height: 34)
      .overlay(alignment: .topTrailing) {
        if badge > 0 {
          Text(badge > 9 ? "9+" : "\(badge)")
            .font(.sans(9, .semibold))
            .foregroundStyle(Palette.primaryForeground)
            .padding(.horizontal, 4)
            .frame(minWidth: 15, minHeight: 15)
            .background(Palette.primary, in: .capsule)
            .offset(x: -2, y: 3)
        }
      }
      .background {
        UnevenRoundedRectangle(
          topLeadingRadius: active ? 17 : 9,
          bottomLeadingRadius: active ? 17 : 9,
          bottomTrailingRadius: 9,
          topTrailingRadius: 9,
          style: .continuous
        )
        .fill(Palette.foreground.opacity(active ? 0.1 : hovering ? 0.08 : 0))
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(action == nil || busy)
    .opacity(action == nil ? 0.45 : 1)
    .onHover { hovering = $0 && action != nil }
    .animation(.easeOut(duration: 0.12), value: hovering)
    .accessibilityLabel(label)
    .help(label)
  }
}

/// The signed-in user's picture, or their initial when there is none or it
/// fails to load (Google rejects some avatar requests outright).
struct UserAvatar: View {
  @Environment(AppModel.self) private var model
  let size: CGFloat

  var body: some View {
    let user = model.user
    ZStack {
      Palette.secondary
      Text(String((user?.name.first ?? user?.email.first ?? "?")).uppercased())
        .font(.sans(size * 0.4, .medium))
        .foregroundStyle(Palette.foreground)
      if let image = user?.image, let url = URL(string: image) {
        RemoteImage(url: url)
      }
    }
    .frame(width: size, height: size)
    .clipShape(.circle)
    .overlay { Circle().strokeBorder(Palette.border) }
    .accessibilityHidden(true)
  }
}
