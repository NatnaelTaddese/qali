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
  static let updateEvent = "domains/calendar/service:updateEvent"
  static let updateEventTime = "domains/calendar/service:updateEventTime"
  static let respondToEvent = "domains/calendar/service:respondToEvent"
  static let deleteEvent = "domains/calendar/service:deleteEvent"
  static let refreshEventRecurrence = "domains/calendar/service:refreshEventRecurrence"
  static let getEventRecurrence = "domains/calendar/queries:getEventRecurrence"
  static let listPeople = "domains/people/queries:listPeople"
  static let updatePreferences = "domains/preferences/mutations:updatePreferences"
  static let setConnectionStatus = "domains/calendar/mutations:setConnectionStatus"
  static let setConnectionContacts = "domains/calendar/mutations:setConnectionContacts"
  static let setCalendarSummaryOverride = "domains/calendar/mutations:setCalendarSummaryOverride"
  static let disconnectAccount = "domains/calendar/connectionService:disconnectAccount"
  static let connectLinkedAccounts = "domains/calendar/connectionService:connectLinkedAccounts"
  static let deleteAccount = "domains/account/deletion:deleteAccount"
}

/// The signed-in user's calendar data: resolved preferences, their calendars,
/// and a live event window. Created once per signed-in session.
@Observable
final class CalendarData {
  /// The row cached from the last session until the live one arrives, nil
  /// when there is none (the calendar then runs on the device's zone and
  /// defaults). Afterwards a transient `null` (an auth-token blip) keeps the
  /// last resolved value, so the calendar never re-cuts its days in the
  /// device zone mid-session.
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
  /// Event windows seen before, drawn while the live window loads.
  @ObservationIgnored private let eventCache = EventCache()
  /// The window `eventsQuery` is pointed at.
  private var eventWindow: (startMs: Double, endMs: Double)?
  private let connectionsQuery: LiveQuery<[ConnectionListItem]>
  /// Today and tomorrow for the menu bar companion, independent of the
  /// window the calendar grid is showing.
  private let agendaQuery: LiveQuery<[CalendarEvent]>
  private let notificationsQuery: LiveQuery<[NotificationRow]>
  /// Every feed result, for the notifier (which outlives the window).
  @ObservationIgnored var onNotifications: (([NotificationRow]) -> Void)?
  private let unreadCountQuery: LiveQuery<Double>
  /// The people directory (guest search and photos), kept for the session
  /// so panels opening again have it at once.
  let peopleQuery: LiveQuery<[PersonRow]>
  /// The booking page, its date overrides and the requests waiting on it.
  let booking: BookingData

  init(client: ConvexClient) {
    self.client = client
    booking = BookingData(client: client)
    preferencesQuery = LiveQuery(client, ConvexAPI.getMyPreferences)
    calendarsQuery = LiveQuery(client, ConvexAPI.listCalendars)
    eventsQuery = LiveQuery(client, ConvexAPI.listEventsInRange, args: nil)
    connectionsQuery = LiveQuery(client, ConvexAPI.listConnections)
    agendaQuery = LiveQuery(client, ConvexAPI.listEventsInRange, args: nil)
    notificationsQuery = LiveQuery(client, ConvexAPI.listNotifications)
    unreadCountQuery = LiveQuery(client, ConvexAPI.unreadNotificationCount)
    peopleQuery = LiveQuery(client, ConvexAPI.listPeople)
    lastPreferences = eventCache.preferences.map(ResolvedPreferences.init)
    eventsQuery.onResult = { [weak self, eventCache] events in
      guard let window = self?.eventWindow else { return }
      eventCache.record(events, startMs: window.startMs, endMs: window.endMs)
    }
    calendarsQuery.onResult = { [eventCache] calendars in eventCache.record(calendars: calendars) }
    notificationsQuery.onResult = { [weak self] rows in self?.onNotifications?(rows) }
    preferencesQuery.onResult = { [weak self, eventCache] stored in
      guard let self, let stored else { return }
      eventCache.record(preferences: stored)
      ZoneRailPrefs.sync(stored, data: self, live: true)
    }
    if let cached = eventCache.preferences { ZoneRailPrefs.sync(cached, data: self, live: false) }
    eventsQuery.onChange = { [weak self] in self?.refreshEvents() }
    refreshEvents()
    booking.announce = { [weak self] message in self?.announce(message) }
  }

  /// The connected accounts, oldest first; nil while loading.
  var connections: [ConnectionListItem]? {
    connectionsQuery.value?.sorted { $0.createdAt < $1.createdAt }
  }

  /// The live list, or the cached one until it arrives (cached events take
  /// their colours from it).
  var calendars: [CalendarListItem] { calendarsQuery.value ?? eventCache.calendars ?? [] }

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
  func run(_ name: String, _ args: @escaping @Sendable () -> [String: ConvexEncodable?] = { [:] }) {
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
    let recurrence = draft.repeatRule?.rrule(zone: zone)
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

  /// Saves an edit (the web's `EventEdit` save): only the patch's fields are
  /// sent. `scope` says how far a repeating event's edit reaches; a series-wide
  /// scope may re-create the series, and Google wants a zone on a repeating
  /// event, so the zone always goes with one. `operationId` keeps a retried
  /// save (a "this and following" split makes a new series) from acting twice.
  func updateEvent(
    _ event: CalendarEvent,
    patch: EventPatch,
    scope: EditScope,
    zone: WorkingZone,
    operationId: String
  ) async throws {
    #if DEBUG
      if DebugFixtures.events != nil { return }
    #endif
    let id = event.id
    let zoneId = zone.identifier
    try await Self.act(client, ConvexAPI.updateEvent) {
      var args: [String: ConvexEncodable?] = [
        "eventId": id,
        "scope": scope.rawValue,
        "operationId": operationId,
      ]
      // An explicit nil is sent as null: that clears the field. (Assigning
      // nil through the subscript would drop the key instead.)
      func put(_ key: String, _ value: String??) {
        guard let value else { return }
        args.updateValue(value.map { $0 as ConvexEncodable }, forKey: key)
      }
      if let summary = patch.summary { args["summary"] = summary }
      put("description", patch.description)
      put("location", patch.location)
      put("color", patch.color)
      put("visibility", patch.visibility)
      if let busy = patch.busy { args["busy"] = busy }
      if let meet = patch.meet { put("conference", .some(meet ? "meet" : nil)) }
      if let times = patch.times {
        args["startMs"] = times.startMs
        args["endMs"] = times.endMs
        args["allDay"] = times.allDay
      }
      if patch.times != nil || patch.recurrence != nil || scope != .thisEvent {
        args["timeZone"] = zoneId
      }
      if let recurrence = patch.recurrence { args["recurrence"] = recurrence.map { $0 as ConvexEncodable? } }
      if let reminders = patch.reminders {
        let encoded: ConvexEncodable? = reminders.map { list in
          list.map { ["method": $0.method, "minutes": $0.minutes] as [String: ConvexEncodable?] as ConvexEncodable? }
        }
        args.updateValue(encoded, forKey: "reminders")
      }
      if let attendees = patch.attendees {
        args["attendees"] = attendees.map { guest -> ConvexEncodable? in
          var attendee: [String: ConvexEncodable?] = ["email": guest.email]
          if let name = guest.displayName { attendee["displayName"] = name }
          if let status = guest.responseStatus { attendee["responseStatus"] = status }
          if let optional = guest.optional { attendee["optional"] = optional }
          return attendee
        }
      }
      return args
    }
  }

  /// Answers an invitation: "accepted", "tentative" or "declined".
  func respond(to event: CalendarEvent, status: String) async throws {
    let id = event.id
    try await Self.act(client, ConvexAPI.respondToEvent) { ["eventId": id, "responseStatus": status] }
  }

  /// Deletes the event, or removes this user's copy when they only guest it.
  /// `scope` picks the instances of a repeating one; `operationId` keeps a
  /// retried delete from acting twice.
  func deleteEvent(_ event: CalendarEvent, scope: String, operationId: String) async throws {
    let id = event.id
    try await Self.act(client, ConvexAPI.deleteEvent) {
      ["eventId": id, "scope": scope, "operationId": operationId]
    }
  }

  /// Asks the server to fetch a repeating event's rule from the provider when
  /// it holds none yet; `getEventRecurrence` then delivers it.
  func refreshRecurrence(of event: CalendarEvent) async throws {
    let id = event.id
    try await Self.act(client, ConvexAPI.refreshEventRecurrence) { ["eventId": id] }
  }

  var people: [PersonRow] { peopleQuery.value ?? [] }

  /// Contact photos by lowercased email, for guest avatars.
  var contactPhotos: [String: String] {
    Dictionary(
      people.compactMap { person in person.photoUrl.map { (person.email.lowercased(), $0) } },
      uniquingKeysWith: { first, _ in first }
    )
  }

  /// Repeating series' rules in words, by series and zone, from the last
  /// time a panel read them: shown at once when one of the series' events
  /// opens again, while its subscription catches up.
  @ObservationIgnored private var recurrenceSummaries: [String: String] = [:]

  func recurrenceSummary(series: String, zone: WorkingZone) -> String? {
    recurrenceSummaries["\(zone.identifier)|\(series)"]
  }

  func rememberRecurrence(_ summary: String, series: String, zone: WorkingZone) {
    recurrenceSummaries["\(zone.identifier)|\(series)"] = summary
  }

  /// The event as the live window has it now, so an RSVP or an edit made
  /// elsewhere shows in a panel opened on an older copy.
  func current(_ event: CalendarEvent) -> CalendarEvent {
    events.first { $0.id == event.id } ?? event
  }

  /// Whether the event's times may be changed from the grid.
  func canReschedule(_ event: CalendarEvent) -> Bool {
    #if DEBUG
      if DebugFixtures.events != nil { return true }
    #endif
    return capabilities(for: event).canEdit
  }

  /// Runs an action and reports its failure to the caller.
  nonisolated static func act(
    _ client: ConvexClient,
    _ name: String,
    _ args: @Sendable () -> [String: ConvexEncodable?]
  ) async throws {
    let _: IgnoredResult = try await client.action(name, with: args())
  }

  /// Shows a line above the island for a few seconds.
  func announce(_ message: String) { post(message) }

  /// Events in the current window (see `setEventWindow`), start-ordered.
  /// Stored, and replaced only when they differ: the grids redraw on a
  /// change, and a window loading or a sync re-sending the same rows is not
  /// one.
  private(set) var events: [CalendarEvent] = []

  private func refreshEvents() {
    let next = currentEvents()
    if next != events { events = next }
  }

  private func currentEvents() -> [CalendarEvent] {
    #if DEBUG
      if let fixture = DebugFixtures.events { return fixture }
    #endif
    // While a new window loads, the live value is still the previous
    // window's: draw what the cache knows of the new one instead (which
    // includes that previous result), so known events don't pop in late.
    if eventsQuery.isLoading || eventsQuery.value == nil, let window = eventWindow,
      let cached = eventCache.events(startMs: window.startMs, endMs: window.endMs)
    {
      return cached
    }
    // In the cache's order, so the live rows replacing the cached ones are
    // not a change when they hold the same events.
    return (eventsQuery.value ?? []).sorted { ($0.startMs, $0.endMs, $0.id) < ($1.startMs, $1.endMs, $1.id) }
  }

  /// True until the first event window has loaded.
  var isLoadingEvents: Bool { eventsQuery.value == nil }

  /// Point the live event subscription at `[startMs, endMs)`. Pass a quantized
  /// window (`eventQueryRange`) so scrolling within it keeps one subscription.
  func setEventWindow(startMs: Double, endMs: Double) {
    if eventWindow?.startMs != startMs || eventWindow?.endMs != endMs { eventWindow = (startMs, endMs) }
    eventsQuery.setArgs(["startMs": startMs, "endMs": endMs])
    refreshEvents()
  }

  /// Points the menu bar's subscription at `[startMs, endMs)`; the same
  /// window again is a no-op.
  func setAgendaWindow(startMs: Double, endMs: Double) {
    agendaQuery.setArgs(["startMs": startMs, "endMs": endMs])
  }

  /// The menu bar's events (see `setAgendaWindow`); nil while loading.
  var agendaEvents: [CalendarEvent]? {
    #if DEBUG
      if let fixture = DebugFixtures.events { return fixture }
    #endif
    return agendaQuery.value
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
