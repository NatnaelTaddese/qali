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
    NotificationSound.install()
    Task { await requestAuthorization() }
    #if DEBUG
      // `-QaliNotify reminder|booking` presents a sample after
      // `-QaliNotifyDelay` seconds (3 by default), in the window or in
      // Notification Center depending on what's in front by then.
      if let kind = UserDefaults.standard.string(forKey: "QaliNotify") {
        let delay = max(UserDefaults.standard.double(forKey: "QaliNotifyDelay"), 3)
        Task {
          try? await Task.sleep(for: .seconds(delay))
          let booking = kind == "booking"
          present(NotificationRow(
            id: "debug-\(kind)-\(Int(Date.now.ms))",
            type: booking ? "booking_requested" : "event_reminder",
            title: booking ? "Ana Silva requested a time" : "Design review",
            body: booking ? "Thu, Nov 26 · 2:00 – 2:30 PM" : "Starts in 10 min",
            read: false, createdAt: Date.now.ms))
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
    if toasts.contains(where: { settled($0.id) }) {
      toasts.removeAll { settled($0.id) }
    }
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
      if toasts.count > Self.maxToasts { toasts.removeFirst(toasts.count - Self.maxToasts) }
      NotificationSound(type: row.type).play()
    } else {
      post(row)
    }
  }

  func dismissToast(_ row: NotificationRow) {
    toasts.removeAll { $0.id == row.id }
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
      content.sound = UNNotificationSound(named: UNNotificationSoundName(NotificationSound(type: row.type).installedName))
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

  /// The name Notification Center sounds it by. It only plays files from
  /// the Sounds folders, never the app's bundle, and it remembers a name it
  /// couldn't find until it restarts, so these aren't the bundle's names:
  /// 0.1.8 asked for those and got the default sound.
  var installedName: String { self == .reminder ? "Qali Reminder.caf" : "Qali Booking.caf" }

  /// Copies the bundled sounds to ~/Library/Sounds, where Notification
  /// Center finds them, replacing any copy that differs from what this
  /// version bundles. The sandbox lets the app write there and nowhere else
  /// outside its container (Qali.entitlements).
  static func install() {
    let files = FileManager.default
    // The real home, not the container's.
    guard let home = getpwuid(getuid())?.pointee.pw_dir else { return }
    let folder = URL(filePath: String(cString: home), directoryHint: .isDirectory)
      .appending(path: "Library/Sounds", directoryHint: .isDirectory)
    try? files.createDirectory(at: folder, withIntermediateDirectories: true)
    for sound in [Self.reminder, .booking] {
      guard let source = Bundle.main.url(forResource: sound.rawValue, withExtension: "caf"),
        let audio = try? Data(contentsOf: source)
      else { continue }
      let target = folder.appending(path: sound.installedName)
      guard (try? Data(contentsOf: target)) != audio else { continue }
      do { try audio.write(to: target, options: .atomic) } catch {
        print("Couldn't install \(sound.installedName):", error)
      }
    }
  }

  /// Sounds still playing. An NSSound nothing holds on to is freed, and
  /// falls silent, the moment `play()` returns.
  private static var playing: [NSSound] = []

  func play() {
    // From the file itself: `NSSound(named:)` doesn't find a bundled CAF.
    // A new one each time, so two arriving together both sound.
    guard Self.isEnabled, let url = Bundle.main.url(forResource: rawValue, withExtension: "caf"),
      let sound = NSSound(contentsOf: url, byReference: true)
    else { return }
    Self.playing.removeAll { !$0.isPlaying }
    Self.playing.append(sound)
    sound.play()
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
