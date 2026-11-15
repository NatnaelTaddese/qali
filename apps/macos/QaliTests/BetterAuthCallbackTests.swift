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
}
