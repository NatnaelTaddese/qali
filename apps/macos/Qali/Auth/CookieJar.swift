import Foundation

/// The Better Auth session cookies, persisted in the Keychain.
///
/// A port of `@better-auth/expo`'s cookie handling (`getSetCookie` /
/// `getCookie` in its client.js) so the native app speaks to the backend
/// exactly like the Expo client: cookies are stored by name with an optional
/// expiry, and every request sends the unexpired ones as a `Cookie` header.
/// URLSession's own cookie storage is bypassed on purpose — the session
/// cookie also arrives in a deep-link query string, not only in responses.
nonisolated final class CookieJar: @unchecked Sendable {
  struct Entry: Codable, Equatable {
    var value: String
    var expires: Date?
  }

  private let account: String
  private let lock = NSLock()
  private var entries: [String: Entry]

  init(account: String = "better-auth-cookies") {
    self.account = account
    if let data = Keychain.read(account),
      let decoded = try? JSONDecoder().decode([String: Entry].self, from: data)
    {
      entries = decoded
    } else {
      entries = [:]
    }
  }

  /// The `Cookie` request header value, or nil when nothing is stored.
  func header(now: Date = .now) -> String? {
    lock.withLock {
      let pairs = entries
        .filter { $0.value.expires.map { $0 > now } ?? true }
        .sorted { $0.key < $1.key }
        .map { "\($0.key)=\($0.value.value)" }
      return pairs.isEmpty ? nil : pairs.joined(separator: "; ")
    }
  }

  func value(named name: String) -> String? {
    lock.withLock { entries[name]?.value }
  }

  /// True when a Better Auth session token is stored (secure-prefixed or not).
  var hasSession: Bool {
    lock.withLock {
      entries["__Secure-better-auth.session_token"] != nil
        || entries["better-auth.session_token"] != nil
    }
  }

  /// Merges a (possibly comma-joined) `Set-Cookie` header into the jar.
  /// Returns true when the jar changed.
  @discardableResult
  func merge(setCookie header: String, now: Date = .now) -> Bool {
    lock.withLock {
      let before = entries
      for cookie in Self.parse(setCookie: header) {
        let expires: Date? =
          if let maxAge = cookie.maxAge { now.addingTimeInterval(TimeInterval(maxAge)) } else {
            cookie.expires
          }
        if let maxAge = cookie.maxAge, maxAge <= 0 {
          entries[cookie.name] = nil
        } else if let expires, expires <= now {
          entries[cookie.name] = nil
        } else {
          entries[cookie.name] = Entry(value: cookie.value, expires: expires)
        }
      }
      guard entries != before else { return false }
      persist()
      return true
    }
  }

  func clear() {
    lock.withLock {
      entries = [:]
      Keychain.delete(account)
    }
  }

  private func persist() {
    if let data = try? JSONEncoder().encode(entries) {
      Keychain.write(data, for: account)
    }
  }

  // MARK: - Parsing

  struct ParsedCookie: Equatable {
    var name: String
    var value: String
    var maxAge: Int?
    var expires: Date?
  }

  /// Better Auth's `parseSetCookieHeader`: split on commas that start a new
  /// `name=` pair (so `Expires=Wed, 21 Oct …` stays intact), then read the
  /// name, the decoded value, and the expiry attributes.
  static func parse(setCookie header: String) -> [ParsedCookie] {
    split(setCookie: header).compactMap { part in
      let segments = part.split(separator: ";", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespaces) }
      guard let nameValue = segments.first, let eq = nameValue.firstIndex(of: "=") else {
        return nil
      }
      let name = String(nameValue[..<eq])
      guard !name.isEmpty else { return nil }
      var raw = String(nameValue[nameValue.index(after: eq)...])
      if raw.count >= 2, raw.hasPrefix("\""), raw.hasSuffix("\"") {
        raw = String(raw.dropFirst().dropLast())
      }
      var cookie = ParsedCookie(name: name, value: raw.removingPercentEncoding ?? raw)
      for attribute in segments.dropFirst() {
        let pieces = attribute.split(separator: "=", maxSplits: 1).map(String.init)
        let key = pieces.first?.trimmingCharacters(in: .whitespaces).lowercased()
        let value = pieces.count > 1 ? pieces[1].trimmingCharacters(in: .whitespaces) : ""
        switch key {
        case "max-age": cookie.maxAge = Int(value)
        case "expires": cookie.expires = httpDate(value)
        default: break
        }
      }
      return cookie
    }
  }

  /// Better Auth's `splitSetCookieHeader`.
  static func split(setCookie header: String) -> [String] {
    let chars = Array(header)
    var result: [String] = []
    var start = 0
    var i = 0
    while i < chars.count {
      if chars[i] == "," {
        var j = i + 1
        while j < chars.count, chars[j] == " " { j += 1 }
        while j < chars.count, chars[j] != "=", chars[j] != ";", chars[j] != "," { j += 1 }
        if j < chars.count, chars[j] == "=" {
          let part = String(chars[start..<i]).trimmingCharacters(in: .whitespaces)
          if !part.isEmpty { result.append(part) }
          start = i + 1
          while start < chars.count, chars[start] == " " { start += 1 }
          i = start
          continue
        }
      }
      i += 1
    }
    let last = String(chars[min(start, chars.count)...]).trimmingCharacters(in: .whitespaces)
    if !last.isEmpty { result.append(last) }
    return result
  }

  private static func httpDate(_ string: String) -> Date? {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "GMT")
    for format in ["EEE, dd MMM yyyy HH:mm:ss zzz", "EEEE, dd-MMM-yy HH:mm:ss zzz", "EEE MMM d HH:mm:ss yyyy"] {
      formatter.dateFormat = format
      if let date = formatter.date(from: string) { return date }
    }
    return nil
  }
}
