import QaliDomain
import SwiftUI

/// The toolbar bell (the web's `NotificationBell`): an unread badge, and a
/// feed of booking requests and event reminders that can be read, dismissed
/// or cleared.
struct NotificationsButton: View {
  let data: CalendarData
  let navigation: CalendarNavigation
  @State private var isOpen = false

  private var unread: Int { data.unreadNotificationCount }

  var body: some View {
    Button {
      isOpen.toggle()
    } label: {
      Image(systemName: unread > 0 ? "bell.badge" : "bell")
        .symbolRenderingMode(.hierarchical)
        .contentTransition(.symbolEffect(.replace))
    }
    .accessibilityLabel(
      unread > 9 ? "Notifications, 10 or more unread" : unread > 0 ? "Notifications, \(unread) unread" : "Notifications"
    )
    .help("Notifications")
    .popover(isPresented: $isOpen, arrowEdge: .bottom) {
      NotificationFeed(data: data, navigation: navigation)
    }
  }
}

private struct NotificationFeed: View {
  let data: CalendarData
  let navigation: CalendarNavigation

  private static let rowHeight: CGFloat = 68

  var body: some View {
    let rows = data.notifications
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Text("Notifications")
          .font(.sans(TextSize.sm, .semibold))
        Spacer()
        if data.unreadNotificationCount > 0 {
          Button("Mark All as Read", systemImage: "checkmark.circle") {
            data.markAllNotificationsRead()
          }
          .labelStyle(.iconOnly)
          .help("Mark all as read")
        }
        if !rows.isEmpty {
          Button("Clear All") { data.clearNotifications() }
        }
      }
      .buttonStyle(.borderless)
      .frame(height: 40)
      .padding(.horizontal, 14)

      if rows.isEmpty {
        Text("You're all caught up")
          .font(.sans(TextSize.sm))
          .foregroundStyle(Palette.mutedForeground)
          .frame(maxWidth: .infinity)
          .frame(height: 84)
      } else {
        ScrollView {
          VStack(spacing: 0) {
            ForEach(rows) { row in
              NotificationItem(row: row, detail: detail(row), data: data)
                .frame(height: Self.rowHeight)
            }
          }
        }
        // Four rows before it scrolls, as on the web.
        .frame(height: CGFloat(min(rows.count, 4)) * Self.rowHeight)
        .padding(.bottom, 6)
      }
    }
    .frame(width: 340)
    .foregroundStyle(Palette.foreground)
    .animation(.snappy(duration: 0.22), value: rows.map(\.id))
  }

  /// The stored body is zone-free ("Starts in 10 min"); with the event in
  /// hand, the reader's clock is the better line.
  private func detail(_ row: NotificationRow) -> String? {
    guard row.type == "event_reminder", let event = row.event else { return row.body }
    if event.allDay { return "All day" }
    let start = Date(timeIntervalSince1970: event.startMs / 1000)
    return "Starts at \(navigation.zone.format(start, timePattern(use24h: navigation.use24h)))"
  }
}

private struct NotificationItem: View {
  let row: NotificationRow
  let detail: String?
  let data: CalendarData
  @State private var isHovered = false

  private static let relative: RelativeDateTimeFormatter = {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    return formatter
  }()

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Circle()
        .fill(row.read ? Color.clear : Palette.foreground)
        .frame(width: 7, height: 7)
        .padding(.top, 5)
      VStack(alignment: .leading, spacing: 1) {
        Text(row.title)
          .font(.sans(TextSize.sm, .medium))
        if let detail {
          Text(detail)
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
        }
        Text(Self.relative.localizedString(for: Date(timeIntervalSince1970: row.createdAt / 1000), relativeTo: .now))
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground.opacity(0.75))
      }
      .lineLimit(1)
      Spacer(minLength: 0)
      Button("Dismiss notification", systemImage: "xmark") {
        data.dismiss(row)
      }
      .labelStyle(.iconOnly)
      .buttonStyle(.borderless)
      .opacity(isHovered ? 1 : 0)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(Palette.foreground.opacity(isHovered ? 0.08 : 0), in: .rect(cornerRadius: 10))
    .padding(.horizontal, 6)
    .contentShape(.rect)
    .onHover { isHovered = $0 }
    .onTapGesture {
      if !row.read { data.markRead(row) }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(row.read ? [] : .isButton)
  }
}
