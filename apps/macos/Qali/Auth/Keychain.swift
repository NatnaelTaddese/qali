import Foundation
import Security

/// Minimal generic-password Keychain storage for the session cookie jar.
///
/// Items live in the login keychain, which ties access to the app's code
/// signature: sign with a stable identity (Config/Local.xcconfig) or every
/// rebuild is a stranger that has to ask before reading the stored session.
///
/// The service names the app and the deployment it talks to, so a session for
/// one backend is never sent to another (Debug talks to dev, Release to prod).
nonisolated enum Keychain {
  private static let service: String = {
    let bundle = Bundle.main.bundleIdentifier ?? "com.myqali.macos"
    let deployment = Bundle.main.object(forInfoDictionaryKey: "QaliConvexDeployment") as? String ?? "unknown"
    return "\(bundle).auth.\(deployment)"
  }()

  static func read(_ account: String) -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
  }

  static func write(_ data: Data, for account: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [kSecValueData as String: data]
    if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
      SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
    }
  }

  static func delete(_ account: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
  }
}
