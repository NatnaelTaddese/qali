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
/// Sparkle's own windows are replaced by `UpdateDriver`, which reports into
/// `status`; the toolbar's `UpdatePill` and Settings draw it.
///
/// Release builds only: Debug is the dev app, which nothing publishes. A Debug
/// build can still be pointed at a feed with `-QaliUpdateFeed <url>` to try
/// an update end to end (see `start()` for the flags).
@Observable
final class AppUpdater: NSObject {
  static let shared = AppUpdater()

  /// The stable feed URL: GitHub redirects `latest/download` to the newest
  /// release's asset, so this stays valid as long as the newest release is a
  /// Mac one that carries appcast.xml.
  static let releaseFeed = "https://github.com/NatnaelTaddese/qali/releases/latest/download/appcast.xml"

  /// Nil when this build doesn't update (Debug without a feed override).
  let feedURL: String?

  /// Where an update stands, for the toolbar pill and Settings.
  var status: UpdateStatus = .idle

  /// Mirrors of the updater's KVO properties, for SwiftUI.
  private(set) var canCheckForUpdates = false
  private(set) var lastCheck: Date?
  var automaticallyChecks = false {
    didSet { if updater?.automaticallyChecksForUpdates != automaticallyChecks { updater?.automaticallyChecksForUpdates = automaticallyChecks } }
  }
  var automaticallyDownloads = false {
    didSet { if updater?.automaticallyDownloadsUpdates != automaticallyDownloads { updater?.automaticallyDownloadsUpdates = automaticallyDownloads } }
  }

  /// Brings the main window forward, where the pill is (set by AppDelegate).
  @ObservationIgnored var revealApp: () -> Void = {}

  @ObservationIgnored private var updater: SPUUpdater?
  @ObservationIgnored private var driver: UpdateDriver?
  @ObservationIgnored private var observations: [NSKeyValueObservation] = []
  /// An update Sparkle downloaded silently and will install on quit, unless
  /// the user relaunches now (automatic downloads on).
  @ObservationIgnored private var installNow: (() -> Void)?

  var isEnabled: Bool { feedURL != nil }

  override private init() {
    #if DEBUG
      feedURL = UserDefaults.standard.string(forKey: "QaliUpdateFeed")
    #else
      feedURL = Self.releaseFeed
    #endif
    super.init()
  }

  /// Starts Sparkle's scheduled checks. Call once the app has finished
  /// launching.
  func start() {
    #if DEBUG
      // `-QaliUpdateState available|checking|downloading|preparing|ready|upToDate|failed`
      // pins the pill to a state for a capture, with no updater running.
      if let pinned = UserDefaults.standard.string(forKey: "QaliUpdateState") {
        status = UpdateStatus.sample(pinned)
        return
      }
    #endif
    guard isEnabled, updater == nil else { return }
    let driver = UpdateDriver(owner: self)
    let updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: driver, delegate: self)
    self.driver = driver
    self.updater = updater
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
    do {
      try updater.start()
    } catch {
      status = .failed(error.localizedDescription)
    }
    #if DEBUG
      // `-QaliCheckInBackground YES` runs a scheduled-style check at launch;
      // with `-QaliAcceptUpdates YES` the pill's buttons press themselves, so
      // an update can be tried end to end (found, downloaded, relaunched)
      // with no clicks.
      if UserDefaults.standard.bool(forKey: "QaliCheckInBackground") {
        updater.checkForUpdatesInBackground()
      }
    #endif
  }

  // MARK: Actions

  /// "Check for Updates…": the pill reports what the check finds.
  func checkForUpdates() {
    NSApp.setActivationPolicy(.regular)
    revealApp()
    updater?.checkForUpdates()
  }

  /// The pill's Update button: download and prepare the update found.
  func install() { driver?.choose(.install) }

  /// Relaunch Now: install the prepared update and reopen.
  func relaunch() {
    if let installNow {
      self.installNow = nil
      status = .preparing
      installNow()
    } else {
      driver?.choose(.install)
    }
  }

  /// The pill's close button. An update that is ready still installs when
  /// Qali quits; one that was only found is offered again on a later check.
  func dismiss() {
    if installNow != nil {
      status = .idle
      return
    }
    driver?.choose(.dismiss)
    status = .idle
  }

  /// "0.1.2": the version alone, as releases are named. The build number
  /// (CFBundleVersion) is only for Sparkle's comparisons.
  static var version: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
  }
}

extension AppUpdater: SPUUpdaterDelegate {
  func feedURLString(for updater: SPUUpdater) -> String? { feedURL }

  /// With automatic downloads on, Sparkle fetches the update silently and
  /// holds it for the next quit; offer to relaunch now instead.
  func updater(
    _ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
    immediateInstallationBlock: @escaping () -> Void
  ) -> Bool {
    installNow = immediateInstallationBlock
    status = .ready(version: item.displayVersionString)
    #if DEBUG
      if UserDefaults.standard.bool(forKey: "QaliAcceptUpdates") { relaunch() }
    #endif
    return true
  }
}

/// Where an update stands. Transient states clear themselves (see UpdateDriver).
enum UpdateStatus: Equatable {
  case idle
  /// A check the user asked for is running.
  case checking
  /// The user's check found nothing (shown briefly).
  case upToDate
  case available(version: String)
  /// Fraction downloaded, or nil before the size is known.
  case downloading(progress: Double?)
  /// Unpacking or installing.
  case preparing
  case ready(version: String)
  /// A check or update failed (shown briefly).
  case failed(String)

  #if DEBUG
    static func sample(_ name: String) -> UpdateStatus {
      switch name {
      case "checking": .checking
      case "upToDate": .upToDate
      case "downloading": .downloading(progress: 0.42)
      case "preparing": .preparing
      case "ready": .ready(version: "0.1.3")
      case "failed": .failed("The update couldn't be downloaded.")
      default: .available(version: "0.1.3")
      }
    }
  #endif
}
