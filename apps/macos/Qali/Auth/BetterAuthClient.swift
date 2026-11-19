import AppKit
import AuthenticationServices
import Foundation
import OSLog

/// The signed-in Better Auth user, as `/get-session` returns it.
struct SessionUser: Codable, Equatable, Sendable {
  var id: String
  var name: String
  var email: String
  var image: String?
}

enum AuthError: LocalizedError {
  case cancelled
  /// The sign-in window never opened (unlike `cancelled`, the user did nothing).
  case browserUnavailable
  case notSignedIn
  case server(status: Int, message: String?)
  case callback(String)
  case malformedResponse

  var errorDescription: String? {
    switch self {
    case .cancelled: "Sign-in was cancelled."
    case .browserUnavailable: "Couldn't open the Google sign-in window."
    case .notSignedIn: "You're not signed in."
    case .server(let status, let message): message ?? "The server returned \(status)."
    case .callback(let code): "Sign-in failed (\(code))."
    case .malformedResponse: "The server sent an unexpected response."
    }
  }
}

/// Talks to Better Auth on the Convex site origin exactly like
/// `@better-auth/expo`'s client: every request carries the stored cookies plus
/// `expo-origin: qali://` (the backend's `expo()` plugin promotes it to
/// `Origin`, which `trustedOrigins` accepts), and OAuth runs through the
/// plugin's `/expo-authorization-proxy` so the callback deep link comes back as
/// `qali:///?cookie=<Set-Cookie>`.
nonisolated final class BetterAuthClient: Sendable {
  let jar: CookieJar
  private let baseURL: URL
  private let session: URLSession

  init(siteURL: URL = AppConfig.siteURL, jar: CookieJar = CookieJar()) {
    self.baseURL = siteURL.appending(path: "api/auth")
    self.jar = jar
    // Cookies are ours to manage (they also arrive via the deep link), so keep
    // URLSession's own cookie storage out of the way.
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    self.session = URLSession(configuration: configuration)
  }

  // MARK: - Sign-in

  /// Runs Google OAuth in an `ASWebAuthenticationSession` and stores the
  /// resulting session cookie. Throws `.cancelled` when the user backs out.
  func signInWithGoogle() async throws {
    struct Body: Encodable {
      let provider = "google"
      // What Expo's `Linking.createURL("/")` yields for a standalone build.
      let callbackURL = "\(AppConfig.authOrigin)/"
      let errorCallbackURL = "\(AppConfig.authOrigin)/sign-in"
    }
    struct Response: Decodable { let url: URL }

    // A new sign-in replaces whatever session was stored before.
    jar.clear()
    let response: Response = try await send("sign-in/social", method: "POST", body: json(Body()))

    // The proxy re-sets the OAuth state cookie inside the browser session, so
    // Google's redirect back to /callback/google carries it.
    var proxy = URLComponents(url: baseURL.appending(path: "expo-authorization-proxy"), resolvingAgainstBaseURL: false)!
    proxy.queryItems = [URLQueryItem(name: "authorizationURL", value: response.url.absoluteString)]
    if let state = jar.value(named: "__Secure-better-auth.oauth_state")
      ?? jar.value(named: "better-auth.oauth_state")
    {
      proxy.queryItems?.append(URLQueryItem(name: "oauthState", value: state))
    }

    let callback = try await WebAuthSession.start(url: proxy.url!, callbackScheme: AppConfig.authScheme)
    let params = Self.callbackParameters(callback)
    if let error = params["error"] {
      throw AuthError.callback(error)
    }
    guard let cookie = params["cookie"] else {
      throw AuthError.malformedResponse
    }
    jar.merge(setCookie: cookie)
    guard jar.hasSession else { throw AuthError.notSignedIn }
  }

  /// Abandons a sign-in that is waiting on the browser; `signInWithGoogle`
  /// then throws `.cancelled`.
  @MainActor
  func cancelSignIn() {
    WebAuthSession.cancelCurrent()
  }

  /// The callback deep link's query, decoded the way the server encoded it:
  /// the `expo()` plugin writes it with `URLSearchParams`, which turns spaces
  /// into `+`. `URLComponents.queryItems` leaves `+` alone, which would glue a
  /// `+` onto every cookie name after the first in the `Set-Cookie` string.
  static func callbackParameters(_ url: URL) -> [String: String] {
    guard let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery else {
      return [:]
    }
    var params: [String: String] = [:]
    for pair in query.split(separator: "&") {
      let parts = pair.split(separator: "=", maxSplits: 1).map {
        $0.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String($0)
      }
      if let name = parts.first, params[name] == nil {
        params[name] = parts.count > 1 ? parts[1] : ""
      }
    }
    return params
  }

  // MARK: - Session

  /// A fresh Convex JWT for the stored session (the `convex()` plugin's
  /// `/convex/token`). Throws `.notSignedIn` when there is no valid session.
  func convexToken() async throws -> String {
    guard jar.hasSession else { throw AuthError.notSignedIn }
    struct Response: Decodable { let token: String }
    do {
      let response: Response = try await send("convex/token")
      return response.token
    } catch AuthError.server(let status, _) where status == 401 || status == 403 {
      throw AuthError.notSignedIn
    }
  }

  func currentUser() async throws -> SessionUser? {
    struct Response: Decodable { let user: SessionUser }
    let response: Response? = try await send("get-session")
    return response?.user
  }

  /// Revokes the session server-side (best effort) and forgets it locally.
  func signOut() async {
    struct Empty: Codable {}
    _ = try? await send("sign-out", method: "POST", body: json(Empty())) as Empty?
    jar.clear()
  }

  // MARK: - Transport

  private struct ErrorBody: Decodable { let message: String? }

  private func json(_ value: some Encodable) throws -> Data {
    try JSONEncoder().encode(value)
  }

  private func send<Response: Decodable>(
    _ path: String,
    method: String = "GET",
    body: Data? = nil
  ) async throws -> Response {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpMethod = method
    request.setValue(AppConfig.authOrigin, forHTTPHeaderField: "expo-origin")
    request.setValue("true", forHTTPHeaderField: "x-skip-oauth-proxy")
    request.setValue("application/json", forHTTPHeaderField: "accept")
    if let cookie = jar.header() {
      request.setValue(cookie, forHTTPHeaderField: "cookie")
    }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = body
    }

    let (data, urlResponse) = try await session.data(for: request)
    guard let http = urlResponse as? HTTPURLResponse else { throw AuthError.malformedResponse }
    if let setCookie = http.value(forHTTPHeaderField: "Set-Cookie") {
      jar.merge(setCookie: setCookie)
    }
    guard (200..<300).contains(http.statusCode) else {
      let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.message
      throw AuthError.server(status: http.statusCode, message: message)
    }
    do {
      return try JSONDecoder().decode(Response.self, from: data)
    } catch {
      throw AuthError.malformedResponse
    }
  }
}

/// `ASWebAuthenticationSession` as an async call. On the Mac it opens the
/// user's default browser (when that browser supports it, otherwise Safari) in
/// a window of its own, anchored to the app's window.
@MainActor
private final class WebAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
  /// The running session. It must be retained until it completes (a released
  /// session cancels itself); the completion handler holds `self` until then.
  private var session: ASWebAuthenticationSession?

  /// The sign-in in flight, so the app can call it off: a browser that is not
  /// Safari does not always report its window being closed.
  private static weak var current: WebAuthSession?

  static func cancelCurrent() {
    current?.session?.cancel()
  }

  static func start(url: URL, callbackScheme: String) async throws -> URL {
    let presenter = WebAuthSession()
    current = presenter
    return try await withCheckedThrowingContinuation { continuation in
      // AppKit delivers the result on a private XPC queue, not the main
      // thread (UIKit happens to use main), so the handler must not be
      // isolated: resume from wherever it lands and tidy up on the main actor.
      let session = ASWebAuthenticationSession(
        url: url,
        callback: .customScheme(callbackScheme)
      ) { @Sendable callbackURL, error in
        Task { @MainActor in presenter.session = nil }
        if let callbackURL {
          continuation.resume(returning: callbackURL)
        } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
          continuation.resume(throwing: AuthError.cancelled)
        } else {
          Logger.auth.error("Web sign-in ended: \(String(describing: error), privacy: .public)")
          continuation.resume(throwing: error ?? AuthError.cancelled)
        }
      }
      session.presentationContextProvider = presenter
      // Share the browser's cookies so a signed-in Google account is offered
      // without re-entering a password.
      session.prefersEphemeralWebBrowserSession = false
      presenter.session = session
      if !session.start() {
        presenter.session = nil
        continuation.resume(throwing: AuthError.browserUnavailable)
      }
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
  }
}

extension Logger {
  nonisolated static let auth = Logger(subsystem: "com.myqali.macos", category: "auth")
}
