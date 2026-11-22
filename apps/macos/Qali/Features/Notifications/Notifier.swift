import AppKit
import ConvexMobile
import Observation
import QaliDomain
import UserNotifications

/// Shows qali's notifications as they land in the feed: event reminders and
/// booking requests. While the calendar window has the user's attention they
/// appear in it, as toasts with the web's sounds; otherwise they go to
/// Notification Center, with the same sounds. Lives for the signed-in
/// session, so it works with the window closed and in menu-bar-only mode.
@Observable
final class Notifier {
  /// Shown over the calendar, oldest first.
  private(set) var toasts: [NotificationRow] = []
  /// Toasts on their way back into the bell; removed once they're there.
  private(set) var leaving = Set<String>()
  /// The toolbar bell's frame in the window's content (top-left origin),
  /// which toasts morph out of and back into; nil until it's laid out.
  var bellFrame: CGRect?
  /// A notification clicked in Notification Center, for the calendar window
  /// to open once it is forward.
  var pendingOpen: NotificationRow?
  /// Whether macOS lets qali post notifications.
  private(set) var authorization: UNAuthorizationStatus = .notDetermined

  /// Brings the calendar window forward; set by the app model.
  @ObservationIgnored var showCalendar: (() -> Void)?

  @ObservationIgnored private var data: CalendarData?
  @ObservationIgnored private var scheduler: ReminderScheduler?
  /// The newest `createdAt` the feed has shown; nil until its first result,
  /// which only sets it, so a launch with unread rows stays quiet.
  @ObservationIgnored private var mark: Double?
  @ObservationIgnored private var presented = Set<String>()
  /// Every row the feed has carried this session.
  @ObservationIgnored private var inFeed = Set<String>()
  /// Posted to Notification Center and not yet withdrawn.
  @ObservationIgnored private var posted = Set<String>()
  @ObservationIgnored private let delegate = NotifierDelegate()
  @ObservationIgnored private var activation: NSObjectProtocol?

  /// A row older than this when it first shows up (the Mac was asleep while
  /// the server fired it) isn't worth interrupting for; it waits in the feed.
  static let freshFor: Double = 10 * 60_000
  static let maxToasts = 3

  init() {
    delegate.notifier = self
    UNUserNotificationCenter.current().delegate = delegate
    // The switch lives in System Settings; pick up a change on return.
    activation = NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { Task { await self?.refreshAuthorization() } }
    }
  }

  /// Starts watching a signed-in session's feed and claiming its reminders.
  func start(_ data: CalendarData) {
    guard self.data !== data else { return }
    self.data = data
    mark = nil
    presented = []
    inFeed = []
    data.onNotifications = { [weak self] rows in self?.receive(rows) }
    scheduler = ReminderScheduler(client: data.client)
    Task { await requestAuthorization() }
    #if DEBUG
      // `-QaliNotify reminder|booking` presents a sample after
      // `-QaliNotifyDelay` seconds (3 by default), in the window or in
      // Notification Center depending on what's in front by then (or as
      // `-notificationStyle inApp|system` says).
      if let kind = UserDefaults.standard.string(forKey: "QaliNotify") {
        let delay = max(UserDefaults.standard.double(forKey: "QaliNotifyDelay"), 3)
        Task {
          try? await Task.sleep(for: .seconds(delay))
          let booking = kind == "booking"
          let row = NotificationRow(
            id: "debug-\(kind)-\(Int(Date.now.ms))",
            type: booking ? "booking_requested" : "event_reminder",
            title: booking ? "Ana Silva requested a time" : "Design review",
            body: booking ? "Thu, Nov 26 · 2:00 – 2:30 PM" : "Starts in 10 min",
            read: false, createdAt: Date.now.ms)
          present(row)
          // `-QaliNotifyDismiss n` sends it back into the bell n seconds on.
          let dismissAfter = UserDefaults.standard.double(forKey: "QaliNotifyDismiss")
          if dismissAfter > 0 {
            try? await Task.sleep(for: .seconds(dismissAfter))
            dismissToast(row)
          }
        }
      }
    #endif
  }

  /// Signed out: nothing more is shown, and what was shown is withdrawn.
  func stop() {
    data?.onNotifications = nil
    data = nil
    scheduler = nil
    mark = nil
    presented = []
    inFeed = []
    toasts = []
    leaving = []
    pendingOpen = nil
    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(posted))
    posted = []
  }

  // MARK: The feed

  private func receive(_ rows: [NotificationRow]) {
    let newest = rows.map(\.createdAt).max()
    guard let mark else {
      self.mark = newest ?? Date.now.ms
      return
    }
    let now = Date.now.ms
    let arrived = rows
      .filter { !$0.read && $0.createdAt > mark && now - $0.createdAt < Self.freshFor && !presented.contains($0.id) }
      .sorted { $0.createdAt < $1.createdAt }
    self.mark = max(mark, newest ?? mark)
    for row in arrived {
      presented.insert(row.id)
      present(row)
    }

    // Read, dismissed or cleared here or on another device: withdraw it.
    // Only rows the feed has carried count; one it hasn't yet isn't gone.
    let unread = Set(rows.filter { !$0.read }.map(\.id))
    inFeed.formUnion(rows.map(\.id))
    let settled = { (id: String) in self.inFeed.contains(id) && !unread.contains(id) }
    let withdrawn = posted.filter(settled)
    if !withdrawn.isEmpty {
      UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(withdrawn))
      posted.subtract(withdrawn)
    }
    for row in toasts where settled(row.id) { dismissToast(row) }
  }

  /// Where the user chose (`NotificationStyle`): by default in the window
  /// when they're looking at it, else in Notification Center. In the window
  /// anyway when macOS won't show it, so nothing is missed.
  func present(_ row: NotificationRow) {
    let allowed = authorization == .authorized || authorization == .provisional
    let inWindow =
      switch NotificationStyle.current {
      case .automatic: isCalendarFocused
      case .inApp: true
      case .system: false
      }
    if inWindow || !allowed {
      toasts.append(row)
      for old in toasts.filter({ !leaving.contains($0.id) }).dropLast(Self.maxToasts) { dismissToast(old) }
      NotificationSound(type: row.type).play()
    } else {
      post(row)
    }
  }

  /// Sends a toast back into the bell, then lets it go.
  func dismissToast(_ row: NotificationRow) {
    guard toasts.contains(where: { $0.id == row.id }), !leaving.contains(row.id) else { return }
    leaving.insert(row.id)
    Task {
      try? await Task.sleep(for: .seconds(Self.morphSeconds + 0.05))
      toasts.removeAll { $0.id == row.id }
      leaving.remove(row.id)
    }
  }

  /// How long a toast takes to morph between the bell and its card.
  static var morphSeconds: Double {
    #if DEBUG
      // `-QaliSlow n` slows it n times, for captures.
      0.45 * max(UserDefaults.standard.double(forKey: "QaliSlow"), 1)
    #else
      0.45
    #endif
  }

  /// The line under the title: the reader's own clock for a reminder whose
  /// event is at hand (the stored body is zone-free), else the stored body.
  func detail(_ row: NotificationRow) -> String? {
    guard row.type == "event_reminder", let event = row.event, let preferences = data?.preferences else {
      return row.body
    }
    if event.allDay { return "All day" }
    let start = Date(timeIntervalSince1970: event.startMs / 1000)
    return "Starts at \(preferences.zone.format(start, timePattern(use24h: preferences.use24h)))"
  }

  /// The calendar window is the app's main window, on screen and in front:
  /// the user would see a toast there. Settings in front, the window
  /// minimised or hidden, or the screen locked all count as away.
  private var isCalendarFocused: Bool {
    guard NSApp.isActive, let window = NSApp.mainWindow,
      window.frameAutosaveName == MainWindowController.autosaveName,
      window.isVisible, !window.isMiniaturized, window.occlusionState.contains(.visible)
    else { return false }
    return true
  }

  // MARK: Notification Center

  private func post(_ row: NotificationRow) {
    let content = UNMutableNotificationContent()
    content.title = row.title
    if let detail = detail(row) { content.body = detail }
    content.threadIdentifier = row.type
    content.userInfo = ["notificationId": row.id]
    if NotificationSound.isEnabled {
      content.sound = UNNotificationSound(named: UNNotificationSoundName(NotificationSound(type: row.type).file))
    }
    posted.insert(row.id)
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: row.id, content: content, trigger: nil)) {
      error in
      if let error { print("Couldn't post a notification:", error) }
    }
  }

  /// A click in Notification Center: the calendar comes forward and opens it.
  fileprivate func openFromSystem(_ id: String) {
    posted.remove(id)
    showCalendar?()
    NSApp.activate()
    if let row = data?.notifications.first(where: { $0.id == id }) { pendingOpen = row }
  }

  func requestAuthorization() async {
    let center = UNUserNotificationCenter.current()
    if await center.notificationSettings().authorizationStatus == .notDetermined {
      _ = try? await center.requestAuthorization(options: [.alert, .sound])
    }
    await refreshAuthorization()
  }

  func refreshAuthorization() async {
    let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    if status != authorization { authorization = status }
  }
}

/// Notification Center's callbacks, which arrive off the main actor.
private final class NotifierDelegate: NSObject, UNUserNotificationCenterDelegate {
  weak var notifier: Notifier?

  /// Posted while qali is frontmost but the calendar isn't (Settings in
  /// front, say): show the banner anyway, since it was posted to be seen.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .list, .sound]
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
    let id = response.notification.request.identifier
    await MainActor.run { notifier?.openFromSystem(id) }
  }
}

/// Where notifications show, per device: the user's choice in Settings ›
/// Events.
enum NotificationStyle: String, CaseIterable, Identifiable {
  /// In qali while its calendar window is in front, otherwise in
  /// Notification Center.
  case automatic
  /// Always in qali's window; they wait there until the user comes back.
  case inApp
  /// Always in Notification Center, even with qali in front.
  case system

  var id: Self { self }

  static let key = "notificationStyle"
  static var current: Self { UserDefaults.standard.string(forKey: key).flatMap(Self.init(rawValue:)) ?? .automatic }

  var label: String {
    switch self {
    case .automatic: "Automatic"
    case .inApp: "Only in qali"
    case .system: "Only in Notification Center"
    }
  }
}

/// The web's notification sounds (cuelume's chime and arrival), rendered to
/// the bundle by scripts/render-sounds.mjs.
enum NotificationSound: String {
  case reminder = "qali-reminder"
  case booking = "qali-booking"

  init(type: String) { self = type == "booking_requested" ? .booking : .reminder }

  /// Per device, on by default, as on the web.
  static let enabledKey = "notificationSounds"
  static var isEnabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }

  var file: String { rawValue + ".caf" }

  func play() {
    guard Self.isEnabled else { return }
    // A copy each time, so two arriving together both sound.
    (NSSound(named: rawValue)?.copy() as? NSSound)?.play()
  }
}

/// One reminder due in the next day (`domains/reminders/queries:upcoming`).
nonisolated struct UpcomingReminder: Decodable, Hashable, Sendable {
  var eventId: String
  var fireAtMs: Double
  var minutes: Double

  var key: String { "\(eventId):\(minutes)" }
}

/// Claims reminders the moment they fall due, as the web's scheduler does,
/// rather than waiting up to a minute for the server's sweep. Claiming writes
/// the feed row the notifier then shows; whoever claims first (this Mac, a
/// web tab, or the sweep) delivers, and the server keeps it to one.
final class ReminderScheduler {
  private let client: ConvexClient
  private let query: LiveQuery<[UpcomingReminder]>
  private var timers: [String: (fireAtMs: Double, task: Task<Void, Never>)] = [:]
  private var bucket: Task<Void, Never>?

  /// The window slides every few minutes, so the query key isn't new on
  /// every call (Convex re-runs on writes, not on the clock).
  static let bucketMs: Double = 5 * 60_000
  static let horizonMs: Double = 24 * 3_600_000
  /// Found past by more than this (the Mac slept through it), it's skipped;
  /// the sweep has delivered it to the feed.
  static let graceMs: Double = 10 * 60_000

  init(client: ConvexClient) {
    self.client = client
    query = LiveQuery(client, "domains/reminders/queries:upcoming", args: nil)
    query.onResult = { [weak self] reminders in self?.apply(reminders) }
    advance()
    bucket = Task { [weak self] in
      while !Task.isCancelled {
        let wait = Self.bucketMs - Date.now.ms.truncatingRemainder(dividingBy: Self.bucketMs)
        try? await Task.sleep(for: .milliseconds(Int(wait) + 50))
        guard let self, !Task.isCancelled else { return }
        self.advance()
      }
    }
  }

  deinit {
    bucket?.cancel()
    for timer in timers.values { timer.task.cancel() }
  }

  private func advance() {
    let from = (Date.now.ms / Self.bucketMs).rounded(.down) * Self.bucketMs
    query.setArgs(["fromMs": from, "horizonMs": Self.horizonMs])
  }

  /// Cancels what's gone or moved and schedules what's new.
  private func apply(_ reminders: [UpcomingReminder]) {
    let wanted = Dictionary(reminders.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
    for (key, timer) in timers where wanted[key]?.fireAtMs != timer.fireAtMs {
      timer.task.cancel()
      timers[key] = nil
    }
    for (key, reminder) in wanted where timers[key] == nil {
      timers[key] = (reminder.fireAtMs, Task { [weak self] in await self?.fire(reminder) })
    }
  }

  private func fire(_ reminder: UpcomingReminder) async {
    let delay = reminder.fireAtMs - Date.now.ms
    if delay > 0 { try? await Task.sleep(for: .milliseconds(Int(delay))) }
    guard !Task.isCancelled, Date.now.ms - reminder.fireAtMs <= Self.graceMs else { return }
    do {
      let _: ClaimResult = try await client.mutation(
        "domains/reminders/mutations:markFired",
        with: ["eventId": reminder.eventId, "minutes": reminder.minutes])
    } catch {
      // The sweep delivers it within the minute.
      print("Couldn't claim a reminder:", error)
    }
  }
}

private nonisolated struct ClaimResult: Decodable {
  var fired: Bool
}
