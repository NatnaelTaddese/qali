import Foundation

/// Deployment endpoints, derived from the `QaliConvexDeployment` Info.plist key
/// that the Debug/Release xcconfigs fill in (dev vs prod).
nonisolated enum AppConfig {
  static let deploymentName: String = {
    guard
      let name = Bundle.main.object(forInfoDictionaryKey: "QaliConvexDeployment") as? String,
      !name.isEmpty
    else { fatalError("QaliConvexDeployment is missing from Info.plist") }
    return name
  }()

  /// The Convex sync (WebSocket) endpoint.
  static let convexURL = "https://\(deploymentName).convex.cloud"

  /// The Convex HTTP-actions origin that serves Better Auth under `/api/auth`.
  static let siteURL = URL(string: "https://\(deploymentName).convex.site")!

  /// The deep-link origin the backend trusts for native sign-in (`nativeOrigins`
  /// in packages/backend/convex/auth.ts). Better Auth matches it by prefix.
  static let authScheme = "qali"
  static let authOrigin = "qali://"

  static let marketingURL = URL(string: "https://myqali.com")!

  /// The web app, which serves booking pages.
  static let webAppURL = URL(string: "https://calendar.myqali.com")!
}
