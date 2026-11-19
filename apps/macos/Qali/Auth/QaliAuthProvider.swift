import ConvexMobile
import Foundation

/// Plugs Better Auth into `ConvexClientWithAuth`. The auth result is the Convex
/// JWT itself.
///
/// Token refresh needs no timer: when Convex rejects an expired JWT, the client
/// calls back into `loginFromCache`, which mints a fresh one from the stored
/// session cookie (the same `/convex/token` round trip `ConvexBetterAuthProvider`
/// makes on the web).
nonisolated final class QaliAuthProvider: AuthProvider {
  let auth: BetterAuthClient

  init(auth: BetterAuthClient) {
    self.auth = auth
  }

  func login(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
    try await auth.signInWithGoogle()
    return try await auth.convexToken()
  }

  func loginFromCache(onIdToken: @Sendable @escaping (String?) -> Void) async throws -> String {
    try await auth.convexToken()
  }

  func logout() async throws {
    await auth.signOut()
  }

  func extractIdToken(from authResult: String) -> String {
    authResult
  }
}
