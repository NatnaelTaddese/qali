import Combine
import ConvexMobile
import Foundation
import Observation

/// App-wide state: the Convex client, the Better Auth session behind it, and
/// which top-level screen to show.
@Observable
final class AppModel {
  enum Phase: Equatable {
    /// Before the cached session has been tried; the loader stays up so a
    /// signed-in user never sees the sign-in screen flash.
    case launching
    case signedOut
    case signedIn
  }

  private(set) var phase: Phase = .launching
  private(set) var user: SessionUser?
  private(set) var isSigningIn = false
  /// The signed-in user's calendar data; nil while signed out.
  private(set) var calendarData: CalendarData?
  var signInError: String?
  /// This version's notes while they wait to be shown once, after an
  /// update; decided as the app starts, before its window opens.
  var whatsNew: ReleaseNotes? = WhatsNew.pending()

  let auth: BetterAuthClient
  let convex: ConvexClientWithAuth<String>

  @ObservationIgnored private var cancellables = Set<AnyCancellable>()

  /// Opens the Settings window on a pane; set by the app delegate.
  @ObservationIgnored var openSettingsPane: ((SettingsPane) -> Void)?
  /// Opens the Settings window on whichever pane it last showed; set by the
  /// app delegate.
  @ObservationIgnored var openSettings: (() -> Void)?
  /// Brings the calendar window forward; set by the app delegate.
  @ObservationIgnored var showCalendar: (() -> Void)? {
    didSet { notifier.showCalendar = showCalendar }
  }
  /// Reminders and booking requests, in the window or Notification Center.
  let notifier = Notifier()

  init() {
    let auth = BetterAuthClient()
    self.auth = auth
    self.convex = ConvexClientWithAuth(
      deploymentUrl: AppConfig.convexURL,
      authProvider: QaliAuthProvider(auth: auth)
    )

    convex.authState
      .receive(on: DispatchQueue.main)
      .sink { [weak self] state in self?.apply(state) }
      .store(in: &cancellables)
  }

  /// Restores the stored session, if any. Called once at launch.
  func restoreSession() async {
    guard phase == .launching else { return }
    #if DEBUG
      // `-QaliScene launching|signedOut|signedIn` pins a screen without
      // touching the network, for looking at one in isolation.
      if let scene = UserDefaults.standard.string(forKey: "QaliScene") {
        switch scene {
        case "signedOut": phase = .signedOut
        case "signedIn":
          let data = CalendarData(client: convex)
          calendarData = data
          notifier.start(data)
          phase = .signedIn
        default: break
        }
        return
      }
    #endif
    if case .failure = await convex.loginFromCache() {
      phase = .signedOut
    }
    #if DEBUG
      // `-QaliSignOut YES` signs the restored session out at launch, the same
      // as choosing Sign Out from the menu.
      if UserDefaults.standard.bool(forKey: "QaliSignOut") { await signOut() }
    #endif
  }

  func signIn() async {
    guard !isSigningIn else { return }
    isSigningIn = true
    signInError = nil
    defer { isSigningIn = false }
    if case .failure(let error) = await convex.login() {
      // Closing the Google window is not an error worth showing.
      if case AuthError.cancelled = error { return }
      signInError = error.localizedDescription
    }
  }

  /// Calls off a sign-in that is waiting on the browser.
  func cancelSignIn() {
    auth.cancelSignIn()
  }

  func signOut() async {
    EventCache.clear()
    // The rail's zones are the account's; the next one brings its own.
    UserDefaults.standard.removeObject(forKey: ZoneRailPrefs.zones)
    await convex.logout()
  }

  private func apply(_ state: AuthState<String>) {
    switch state {
    case .loading:
      // Keep the current screen while a sign-in or refresh is in flight;
      // only the very first resolution leaves `.launching`.
      break
    case .authenticated:
      // Token refreshes re-publish `.authenticated`; only a new session
      // creates the data model and runs the one-time sync bootstrap.
      if calendarData == nil {
        let data = CalendarData(client: convex)
        calendarData = data
        notifier.start(data)
        Task { [convex] in await SyncBootstrap.run(convex) }
      }
      phase = .signedIn
      Task { self.user = try? await auth.currentUser() }
    case .unauthenticated:
      // The initial publisher value is `.unauthenticated`; ignore it until
      // `restoreSession` has actually tried the cache.
      if phase != .launching { phase = .signedOut }
      user = nil
      calendarData = nil
      notifier.stop()
    }
  }
}
