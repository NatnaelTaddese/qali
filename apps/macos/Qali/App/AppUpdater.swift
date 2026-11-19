import AppKit
import Observation
import Sparkle

/// Sparkle, reading the appcast the release workflow publishes beside each
/// GitHub release (.github/workflows/macos-release.yml). Updates are verified
/// by their EdDSA signature against `SUPublicEDKey`, which is what lets
/// ad-hoc signed builds update each other. The app is sandboxed, so Sparkle
/// installs through its Installer XPC service (`SUEnableInstallerLauncherService`
/// and the `-spks`/`-spki` mach-lookup exceptions in project.yml).
///
/// Release builds only: Debug is the dev app, which nothing publishes. A Debug
/// build can still be pointed at a feed with `-QaliUpdateFeed <url>` to try
/// an update end to end.
@Observable
final class AppUpdater: NSObject {
  static let shared = AppUpdater()

  /// The stable feed URL: GitHub redirects `latest/download` to the newest
  /// release's asset, so this stays valid as long as the newest release is a
  /// Mac one that carries appcast.xml.
  static let releaseFeed = "https://github.com/NatnaelTaddese/qali/releases/latest/download/appcast.xml"

  /// Nil when this build doesn't update (Debug without a feed override).
  let feedURL: String?

  /// Mirrors of the updater's KVO properties, for SwiftUI.
  private(set) var canCheckForUpdates = false
  private(set) var lastCheck: Date?
  var automaticallyChecks = false {
    didSet { if updater?.automaticallyChecksForUpdates != automaticallyChecks { updater?.automaticallyChecksForUpdates = automaticallyChecks } }
  }
  var automaticallyDownloads = false {
    didSet { if updater?.automaticallyDownloadsUpdates != automaticallyDownloads { updater?.automaticallyDownloadsUpdates = automaticallyDownloads } }
  }

  @ObservationIgnored private var controller: SPUStandardUpdaterController?
  @ObservationIgnored private var observations: [NSKeyValueObservation] = []

  var isEnabled: Bool { feedURL != nil }
  private var updater: SPUUpdater? { controller?.updater }

  override private init() {
    #if DEBUG
      feedURL = UserDefaults.standard.string(forKey: "QaliUpdateFeed")
    #else
      feedURL = Self.releaseFeed
    #endif
    super.init()
  }

  /// Starts Sparkle's scheduled checks. Call once the app has finished
  /// launching, so a first-launch prompt or update alert has an app to sit in.
  func start() {
    guard isEnabled, controller == nil else { return }
    let controller = SPUStandardUpdaterController(
      startingUpdater: false, updaterDelegate: self, userDriverDelegate: self
    )
    self.controller = controller
    let updater = controller.updater
    observations = [
      updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] updater, _ in
        MainActor.assumeIsolated { self?.canCheckForUpdates = updater.canCheckForUpdates }
      },
      updater.observe(\.lastUpdateCheckDate, options: [.initial, .new]) { [weak self] updater, _ in
        MainActor.assumeIsolated { self?.lastCheck = updater.lastUpdateCheckDate }
      },
      updater.observe(\.automaticallyChecksForUpdates, options: [.initial, .new]) { [weak self] updater, _ in
        MainActor.assumeIsolated { self?.automaticallyChecks = updater.automaticallyChecksForUpdates }
      },
      updater.observe(\.automaticallyDownloadsUpdates, options: [.initial, .new]) { [weak self] updater, _ in
        MainActor.assumeIsolated { self?.automaticallyDownloads = updater.automaticallyDownloadsUpdates }
      },
    ]
    controller.startUpdater()
    #if DEBUG
      // `-QaliUpdateFeed <url> -QaliCheckInBackground YES -SUAutomaticallyUpdate YES`
      // runs a silent check that downloads the update and installs it when the
      // app quits: an update tried end to end with no clicks.
      if UserDefaults.standard.bool(forKey: "QaliCheckInBackground") {
        updater.checkForUpdatesInBackground()
      }
    #endif
  }

  /// "Check for Updates…": Sparkle's own window reports what it finds.
  func checkForUpdates() {
    NSApp.setActivationPolicy(.regular)
    controller?.checkForUpdates(nil)
  }

  /// "0.1.0 (4)", as the About panel shows it.
  static var versionDescription: String {
    let info = Bundle.main.infoDictionary ?? [:]
    let version = info["CFBundleShortVersionString"] as? String ?? "?"
    let build = info["CFBundleVersion"] as? String ?? "?"
    return "\(version) (\(build))"
  }
}

extension AppUpdater: SPUUpdaterDelegate {
  func feedURLString(for updater: SPUUpdater) -> String? { feedURL }
}

extension AppUpdater: @preconcurrency SPUStandardUserDriverDelegate {
  /// Lets a scheduled check that finds an update wait for a calmer moment
  /// instead of throwing a window up mid-task; Sparkle handles the reminder.
  var supportsGentleScheduledUpdateReminders: Bool { true }

  /// The app may be running Dock-less behind the menu bar companion; bring
  /// the Dock icon back so the update window can come forward.
  func standardUserDriverWillHandleShowingUpdate(
    _ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState
  ) {
    guard handleShowingUpdate else { return }
    NSApp.setActivationPolicy(.regular)
    NSApp.activate()
  }
}
