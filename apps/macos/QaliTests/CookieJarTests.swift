import Foundation
import Testing
@testable import Qali

@MainActor
struct CookieJarTests {
  @Test func splitKeepsExpiresDatesIntact() {
    let header =
      "__Secure-better-auth.session_token=abc.def%3D; Path=/; Expires=Wed, 21 Oct 2099 07:28:00 GMT; HttpOnly; Secure, better-auth.state=xyz; Max-Age=300"
    let parts = CookieJar.split(setCookie: header)
    #expect(parts.count == 2)
    let cookies = CookieJar.parse(setCookie: header)
    #expect(cookies[0].name == "__Secure-better-auth.session_token")
    #expect(cookies[0].value == "abc.def=")
    #expect(cookies[0].expires != nil)
    #expect(cookies[1].maxAge == 300)
  }

  @Test func mergeDropsExpiredAndBuildsHeader() {
    let jar = CookieJar(account: "test-\(UUID().uuidString)")
    defer { jar.clear() }
    jar.merge(setCookie: "a=1; Max-Age=60, b=2")
    #expect(jar.header() == "a=1; b=2")
    jar.merge(setCookie: "a=; Max-Age=0")
    #expect(jar.header() == "b=2")
    #expect(!jar.hasSession)
    jar.merge(setCookie: "better-auth.session_token=t")
    #expect(jar.hasSession)
  }
}
