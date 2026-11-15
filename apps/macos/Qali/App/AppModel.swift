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

  let auth: BetterAuthClient
  let convex: ConvexClientWithAuth<String>

  @ObservationIgnored private var cancellables = Set<AnyCancellable>()

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
          calendarData = CalendarData(client: convex)
          phase = .signedIn
        default: break
        }
        return
      }
    #endif
    if case .failure = await convex.loginFromCache() {
      phase = .signedOut
    }
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
        calendarData = CalendarData(client: convex)
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
    }
  }
}
