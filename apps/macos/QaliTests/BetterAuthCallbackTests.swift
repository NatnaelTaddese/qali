import Foundation
import Testing
@testable import Qali

@MainActor
struct BetterAuthCallbackTests {
  /// Built by the backend's `expo()` plugin via `URLSearchParams.set`
  /// (spaces → `+`), captured from bun.
  private let callback = URL(string:
    "qali:///?cookie=__Secure-better-auth.state%3D%3B+Max-Age%3D0%3B+Path%3D%2F%3B+HttpOnly%3B+Secure%3B+SameSite%3DLax%2C+__Secure-better-auth.session_token%3Dtok.sig%252B%253D%3B+Max-Age%3D604800%3B+Path%3D%2F%3B+HttpOnly%3B+Secure%3B+SameSite%3DLax&ott=x"
  )!

  @Test func decodesPlusAsSpace() {
    let params = BetterAuthClient.callbackParameters(callback)
    #expect(params["ott"] == "x")
    #expect(params["cookie"]?.contains(", __Secure-better-auth.session_token=tok.sig%2B%3D; Max-Age=604800") == true)
  }

  @Test func sessionCookieSurvivesIntoTheJar() {
    let jar = CookieJar(account: "test-\(UUID().uuidString)")
    defer { jar.clear() }
    jar.merge(setCookie: BetterAuthClient.callbackParameters(callback)["cookie"]!)
    #expect(jar.hasSession)
    #expect(jar.header() == "__Secure-better-auth.session_token=tok.sig+=")
  }

  // MARK: - Linking

  @Test func forwardedCallbackIsReplayed() {
    // As `nativeLinkForwardURL` in the backend writes it.
    let url = URL(string: "qali:///link-callback/google?code=4%2F0Ab%2Bc+d&state=st8")!
    #expect(BetterAuthClient.linkOutcome(url) == .replay(provider: "google", query: "code=4%2F0Ab%2Bc+d&state=st8"))
  }

  @Test func forwardedProviderErrorIsReplayedToo() {
    let url = URL(string: "qali:///link-callback/google?state=st8&error=access_denied")!
    #expect(BetterAuthClient.linkOutcome(url) == .replay(provider: "google", query: "state=st8&error=access_denied"))
  }

  @Test func linkedRedirectSucceeds() {
    // expo() appends the expired state cookie to a native callback redirect.
    let url = URL(string: "qali:///?linked=google&cookie=better-auth.state%3D%3B+Max-Age%3D0")!
    #expect(BetterAuthClient.linkOutcome(url) == .linked)
  }

  @Test func errorRedirectFails() {
    let url = URL(string: "qali:///?linkError=google&error=account_already_linked_to_different_user")!
    #expect(BetterAuthClient.linkOutcome(url) == .failed("account_already_linked_to_different_user"))
    let mismatch = URL(string: "qali:///?linkError=google&error=link_session_mismatch")!
    #expect(BetterAuthClient.linkOutcome(mismatch) == .failed("link_session_mismatch"))
  }

  @Test func unexpectedDeepLinksAreRejected() {
    #expect(BetterAuthClient.linkOutcome(URL(string: "qali:///")!) == .unexpected)
    #expect(BetterAuthClient.linkOutcome(URL(string: "qali:///link-callback/google?code=x")!) == .unexpected)
    #expect(BetterAuthClient.linkOutcome(URL(string: "qali:///link-callback/..%2Fsign-out?state=s")!) == .unexpected)
    #expect(BetterAuthClient.linkOutcome(URL(string: "qali:///link-callback/?state=s")!) == .unexpected)
  }
}
