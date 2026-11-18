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
  static let searchEvents = "domains/calendar/queries:searchEvents"
  static let listConnections = "domains/calendar/queries:listConnections"
  static let setCalendarSelected = "domains/calendar/mutations:setCalendarSelected"
  static let listNotifications = "domains/notifications/queries:list"
  static let unreadNotificationCount = "domains/notifications/queries:unreadCount"
  static let markNotificationRead = "domains/notifications/mutations:markRead"
  static let markAllNotificationsRead = "domains/notifications/mutations:markAllRead"
  static let dismissNotification = "domains/notifications/mutations:dismiss"
  static let clearNotifications = "domains/notifications/mutations:clearAll"
  static let createEvent = "domains/calendar/service:createEvent"
  static let updateEventTime = "domains/calendar/service:updateEventTime"
  static let listPeople = "domains/people/queries:listPeople"
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

  // MARK: Sync

  /// True while a manual sync is in flight.
  private(set) var isSyncing = false
  /// A line about a sync that did not go through, shown briefly by the island.
  private(set) var notice: String?

  /// Manual "sync now" (the web's `useSyncNow`).
  func syncNow() async {
    guard !isSyncing else { return }
    isSyncing = true
    defer { isSyncing = false }
    switch await SyncBootstrap.sync(client) {
    case .done:
      break
    case .rateLimited:
      post("Your calendar was synced very recently. It keeps syncing in the background.")
    case .failed:
      post("Couldn't sync your calendar.")
    }
  }

  private func post(_ message: String) {
    notice = message
    Task {
      try? await Task.sleep(for: .seconds(5))
      if notice == message { notice = nil }
    }
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

  // MARK: Creating events

  /// Calendars a new event can go to: writable and the user's own (a shared
  /// public calendar is read-only by construction).
  var writableCalendars: [CalendarListItem] {
    calendarGroups.flatMap(\.calendars).filter { $0.isWritable && !($0.isShared ?? false) }
  }

  /// Where a new event goes when none is picked (the web's create form): the
  /// default-calendar preference while it is still writable, else the
  /// preferred connection's primary calendar. Nil leaves the choice to the
  /// server, which is what happens while the connections are loading.
  var defaultCalendar: CalendarListItem? {
    if let id = preferences?.raw.defaultCalendarId,
      let stored = writableCalendars.first(where: { $0.id == id })
    {
      return stored
    }
    let primaries = calendars.filter { $0.primary ?? false }
    if primaries.count <= 1 { return primaries.first }
    guard let connections = connectionsQuery.value else { return nil }
    // The backend's `preferredConnection`: active, Google first, oldest.
    let preferred = connections
      .filter { $0.status == "active" }
      .sorted { a, b in
        let googleA = a.provider == "google", googleB = b.provider == "google"
        return googleA != googleB ? googleA : a.createdAt < b.createdAt
      }
      .first
    return primaries.first { $0.connectionId == preferred?.id } ?? primaries.first
  }

  /// The user's default reminder offsets, for the form's "Default · …" label.
  func defaultReminders(allDay: Bool) -> [Double]? {
    allDay ? preferences?.raw.defaultAllDayReminderMinutes : preferences?.raw.defaultReminderMinutes
  }

  /// Creates the event on the provider (the web's `EventCreate` submit).
  /// `operationId` is the idempotency key: reuse it when retrying the same
  /// draft, so a lost response cannot create the event twice.
  func createEvent(_ draft: EventDraft, calendarId: String?, zone: WorkingZone, operationId: String) async throws {
    let times = draft.eventTimes(zone: zone)
    let summary = draft.summary.trimmingCharacters(in: .whitespacesAndNewlines)
    let location = draft.location.trimmingCharacters(in: .whitespacesAndNewlines)
    let recurrence = draft.repeatRule?.rrule(startMs: draft.startMs, zone: zone)
    let reminders = draft.reminders.map { Array(Set($0)).sorted().prefix(5) }.map(Array.init)
    let notes = draft.notesHTML
    let zoneId = zone.identifier
    try await Self.act(client, ConvexAPI.createEvent) {
      var args: [String: ConvexEncodable?] = [
        "operationId": operationId,
        "summary": summary.isEmpty ? "New event" : summary,
        "startMs": times.startMs,
        "endMs": times.endMs,
        "allDay": draft.allDay,
        // The working zone: the grid renders in it and the pickers compose
        // in it, so it is the honest recurrence anchor.
        "timeZone": zoneId,
      ]
      if let notes { args["description"] = notes }
      // A Meet and a place are the two modes of one row.
      if draft.meet {
        args["addConference"] = true
      } else if !location.isEmpty {
        args["location"] = location
      }
      if let calendarId { args["calendarId"] = calendarId }
      if let color = draft.color { args["color"] = color }
      if draft.isPrivate { args["visibility"] = "private" }
      // Busy is the provider default; only Free is sent.
      if !draft.busy { args["busy"] = false }
      if let recurrence { args["recurrence"] = recurrence.map { $0 as ConvexEncodable? } }
      if !draft.guests.isEmpty {
        args["attendees"] = draft.guests.map { guest -> ConvexEncodable? in
          var attendee: [String: ConvexEncodable?] = ["email": guest.email]
          if let name = guest.displayName { attendee["displayName"] = name }
          return attendee
        }
      }
      // Absent is the calendar's default; an explicit list, even empty, is sent.
      if let reminders {
        args["reminders"] = reminders.map { minutes -> ConvexEncodable? in
          ["method": "popup", "minutes": minutes] as [String: ConvexEncodable?]
        }
      }
      return args
    }
  }

  /// Moves or resizes a timed event (the web's drag commit). `zone` is the
  /// working zone the grid's day columns are cut in; Google anchors the
  /// instant to it.
  func updateEventTime(_ event: CalendarEvent, startMs: Double, endMs: Double, zone: WorkingZone) async throws {
    #if DEBUG
      // Fixture events exist only here: hold the new times until the pending
      // override times out.
      if DebugFixtures.events != nil { return }
    #endif
    let id = event.id
    let zoneId = zone.identifier
    try await Self.act(client, ConvexAPI.updateEventTime) {
      ["eventId": id, "startMs": startMs, "endMs": endMs, "timeZone": zoneId]
    }
  }

  /// Whether the event's times may be changed from the grid.
  func canReschedule(_ event: CalendarEvent) -> Bool {
    #if DEBUG
      if DebugFixtures.events != nil { return true }
    #endif
    return capabilities(for: event).canEdit
  }

  /// Runs an action and reports its failure to the caller.
  private nonisolated static func act(
    _ client: ConvexClient,
    _ name: String,
    _ args: @Sendable () -> [String: ConvexEncodable?]
  ) async throws {
    let _: IgnoredResult = try await client.action(name, with: args())
  }

  /// Shows a line above the island for a few seconds.
  func announce(_ message: String) { post(message) }

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
  enum Outcome {
    case done
    /// The sync budget is spent; the background schedule carries on.
    case rateLimited
    case failed
  }

  /// Once per signed-in session, at launch.
  static func run(_ client: ConvexClient) async {
    _ = await sync(client)
  }

  static func sync(_ client: ConvexClient) async -> Outcome {
    do {
      // The status it returns isn't needed; decode and drop it.
      let _: IgnoredResult = try await client.action(ConvexAPI.syncNow)
      return .done
    } catch ClientError.ConvexError(let data) where data.contains("SYNC_RATE_LIMIT") {
      return .rateLimited
    } catch {
      print("Sync failed:", error)
      return .failed
    }
  }
}
