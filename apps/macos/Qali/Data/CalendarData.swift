import ConvexMobile
import Foundation
import Observation
import QaliDomain

/// Convex function paths, in one place (the Swift side has no generated `api`).
enum ConvexAPI {
  static let listEventsInRange = "domains/calendar/queries:listEventsInRange"
  static let listCalendars = "domains/calendar/queries:listCalendars"
  static let getMyPreferences = "domains/preferences/queries:getMyPreferences"
  static let syncNow = "domains/sync/engine:syncNow"
  static let listConnections = "domains/calendar/queries:listConnections"
  static let setCalendarSelected = "domains/calendar/mutations:setCalendarSelected"
  static let listNotifications = "domains/notifications/queries:list"
  static let unreadNotificationCount = "domains/notifications/queries:unreadCount"
  static let markNotificationRead = "domains/notifications/mutations:markRead"
  static let markAllNotificationsRead = "domains/notifications/mutations:markAllRead"
  static let dismissNotification = "domains/notifications/mutations:dismiss"
  static let clearNotifications = "domains/notifications/mutations:clearAll"
}

/// The signed-in user's calendar data: resolved preferences, their calendars,
/// and a live event window. Created once per signed-in session.
@Observable
final class CalendarData {
  /// Nil until the first real preferences row arrives; afterwards a transient
  /// `null` (an auth-token blip) keeps the last resolved value, so the
  /// calendar never re-cuts its days in the device zone mid-session.
  var preferences: ResolvedPreferences? {
    if let stored = preferencesQuery.value ?? nil {
      lastPreferences = ResolvedPreferences(stored)
    }
    return lastPreferences
  }

  @ObservationIgnored private var lastPreferences: ResolvedPreferences?
  @ObservationIgnored let client: ConvexClient
  private let preferencesQuery: LiveQuery<StoredPreferences?>
  private let calendarsQuery: LiveQuery<[CalendarListItem]>
  private let eventsQuery: LiveQuery<[CalendarEvent]>
  private let connectionsQuery: LiveQuery<[ConnectionListItem]>
  private let notificationsQuery: LiveQuery<[NotificationRow]>
  private let unreadCountQuery: LiveQuery<Double>

  init(client: ConvexClient) {
    self.client = client
    preferencesQuery = LiveQuery(client, ConvexAPI.getMyPreferences)
    calendarsQuery = LiveQuery(client, ConvexAPI.listCalendars)
    eventsQuery = LiveQuery(client, ConvexAPI.listEventsInRange, args: nil)
    connectionsQuery = LiveQuery(client, ConvexAPI.listConnections)
    notificationsQuery = LiveQuery(client, ConvexAPI.listNotifications)
    unreadCountQuery = LiveQuery(client, ConvexAPI.unreadNotificationCount)
  }

  var calendars: [CalendarListItem] { calendarsQuery.value ?? [] }

  /// The calendars in the toolbar picker's order (primary first, then by
  /// name), grouped by connected account once there is more than one account.
  var calendarGroups: [CalendarGroup] {
    let sorted = calendars.sorted { a, b in
      if (a.primary ?? false) != (b.primary ?? false) { return a.primary ?? false }
      return a.displayName.localizedCompare(b.displayName) == .orderedAscending
    }
    return groupCalendarsByAccount(sorted, connections: connectionsQuery.value ?? [])
  }

  /// Shows or hides a calendar on the grid (a per-user setting, synced).
  func setCalendar(_ calendar: CalendarListItem, selected: Bool) {
    let id = calendar.id
    run(ConvexAPI.setCalendarSelected) { ["calendarId": id, "selected": selected] }
  }

  // MARK: Notifications

  /// Newest first, as the bell lists them.
  var notifications: [NotificationRow] { notificationsQuery.value ?? [] }

  var unreadNotificationCount: Int { Int(unreadCountQuery.value ?? 0) }

  func markRead(_ notification: NotificationRow) {
    let id = notification.id
    run(ConvexAPI.markNotificationRead) { ["notificationId": id] }
  }

  func dismiss(_ notification: NotificationRow) {
    let id = notification.id
    run(ConvexAPI.dismissNotification) { ["notificationId": id] }
  }

  func markAllNotificationsRead() { run(ConvexAPI.markAllNotificationsRead) }

  func clearNotifications() { run(ConvexAPI.clearNotifications) }

  /// Fires a mutation whose result nobody reads; the subscriptions carry the
  /// outcome back. The arguments are built off the main actor (a dictionary
  /// of `ConvexEncodable` is not Sendable), hence the closure.
  private func run(_ name: String, _ args: @escaping @Sendable () -> [String: ConvexEncodable?] = { [:] }) {
    Task { [client] in await Self.perform(client, name, args) }
  }

  private nonisolated static func perform(
    _ client: ConvexClient,
    _ name: String,
    _ args: @Sendable () -> [String: ConvexEncodable?]
  ) async {
    do {
      let _: IgnoredResult = try await client.mutation(name, with: args())
    } catch {
      print("\(name) failed:", error)
    }
  }

  /// Events in the current window (see `setEventWindow`), start-ordered.
  var events: [CalendarEvent] {
    #if DEBUG
      if let fixture = DebugFixtures.events { return fixture }
    #endif
    return eventsQuery.value ?? []
  }

  /// True until the first event window has loaded.
  var isLoadingEvents: Bool { eventsQuery.value == nil }

  /// Point the live event subscription at `[startMs, endMs)`. Pass a quantized
  /// window (`eventQueryRange`) so scrolling within it keeps one subscription.
  func setEventWindow(startMs: Double, endMs: Double) {
    eventsQuery.setArgs(["startMs": startMs, "endMs": endMs])
  }

  func calendar(id: String?) -> CalendarListItem? {
    guard let id else { return nil }
    return calendars.first { $0.id == id }
  }

  /// The event's palette key: its own colour, then its calendar's, then a hash.
  func colorKey(for event: CalendarEvent) -> EventPaletteKey {
    let colors = Dictionary(
      calendars.compactMap { calendar in calendar.backgroundColor.map { (calendar.id, $0) } },
      uniquingKeysWith: { first, _ in first }
    )
    return eventColorKey(event, calendarColors: colors)
  }

  /// What the user may do to the event, judged against its calendar's access
  /// role — the same rules the backend enforces.
  func capabilities(for event: CalendarEvent) -> EventCapabilities {
    eventCapabilities(event.accessFacts, calendarAccessRole: calendar(id: event.localCalendarId)?.accessRole)
  }
}

/// Decodes any JSON value and keeps nothing (ConvexMobile's untyped `action`
/// insists on decoding the result as a String).
private nonisolated struct IgnoredResult: Decodable {
  init(from decoder: Decoder) throws {}
}

/// Once per signed-in session: register for background sync and pull a first
/// snapshot, as the web workspace and the Expo app do. This is also what turns
/// a brand-new Google grant into the user's first calendar connection.
enum SyncBootstrap {
  static func run(_ client: ConvexClient) async {
    do {
      // The status it returns isn't needed; decode and drop it.
      let _: IgnoredResult = try await client.action(ConvexAPI.syncNow)
    } catch ClientError.ConvexError(let data) where data.contains("SYNC_RATE_LIMIT") {
      // Shares the manual "sync now" budget; the background schedule carries on.
    } catch {
      print("Initial sync failed:", error)
    }
  }
}
