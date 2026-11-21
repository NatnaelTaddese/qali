import AppKit
import SwiftUI

/// A version's release notes, as bundled from apps/macos/ReleaseNotes/<version>.md
/// (the same file the GitHub release and the update feed use).
struct ReleaseNotes: Identifiable, Equatable {
  struct Item: Identifiable, Equatable {
    let id: Int
    /// The bullet's bold lead-in, without its full stop; empty when it has none.
    let title: String
    /// The rest of the bullet, still inline Markdown.
    let body: String
  }

  let version: String
  let items: [Item]
  var id: String { version }

  /// Reads the notes' "- **Title.** Body" bullets; nil when there are none.
  init?(version: String, markdown: String) {
    let bullets = markdown.split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { $0.hasPrefix("- ") }
      .map { String($0.dropFirst(2)) }
    guard !bullets.isEmpty else { return nil }
    self.version = version
    items = bullets.enumerated().map { index, bullet in
      guard bullet.hasPrefix("**"), let close = bullet.range(of: "**", range: bullet.index(bullet.startIndex, offsetBy: 2)..<bullet.endIndex)
      else { return Item(id: index, title: "", body: bullet) }
      var title = String(bullet[bullet.index(bullet.startIndex, offsetBy: 2)..<close.lowerBound])
      if title.hasSuffix(".") { title.removeLast() }
      let body = bullet[close.upperBound...].trimmingCharacters(in: .whitespaces)
      return Item(id: index, title: title, body: body)
    }
  }

  /// The notes bundled for `version`, if the app carries any.
  static func bundled(version: String) -> ReleaseNotes? {
    guard let url = Bundle.main.url(forResource: version, withExtension: "md"),
      let markdown = try? String(contentsOf: url, encoding: .utf8)
    else { return nil }
    return ReleaseNotes(version: version, markdown: markdown)
  }
}

/// Whether this launch follows an update, so the calendar shows the new
/// version's notes once.
enum WhatsNew {
  /// The last version whose notes were shown (or that was installed fresh).
  static let lastSeenKey = "WhatsNewLastSeenVersion"

  static var currentVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
  }

  /// The notes to show this launch, or nil. Runs once, before the main
  /// window opens: a copy that predates this sheet has no record of what it
  /// showed, and a main window frame it saved is what tells an update from a
  /// fresh install.
  static func pending() -> ReleaseNotes? {
    let defaults = UserDefaults.standard
    let current = currentVersion
    #if DEBUG
      // `-QaliWhatsNew YES` shows the sheet whatever was seen before;
      // `-QaliWhatsNewVersion 0.1.5` picks which notes.
      if defaults.bool(forKey: "QaliWhatsNew") {
        return ReleaseNotes.bundled(version: defaults.string(forKey: "QaliWhatsNewVersion") ?? current)
      }
    #endif
    let previous = defaults.string(forKey: lastSeenKey)
    let updated = isUpdate(
      previous: previous,
      current: current,
      usedBefore: defaults.object(forKey: "NSWindow Frame QaliMainWindow") != nil
    )
    if updated, let notes = ReleaseNotes.bundled(version: current) { return notes }
    // A fresh install, or a version with nothing to tell: nothing to show
    // until the next update. (A downgrade keeps the newer record.)
    if previous == nil || updated { defaults.set(current, forKey: lastSeenKey) }
    return nil
  }

  /// Whether `current` is newer than what this Mac last ran. Without a
  /// record, a copy that has been used before (it saved a window) is one
  /// that predates the sheet, so it counts as an update; a fresh install
  /// doesn't.
  static func isUpdate(previous: String?, current: String, usedBefore: Bool) -> Bool {
    guard let previous else { return usedBefore }
    return previous.compare(current, options: .numeric) == .orderedAscending
  }

  /// Records that `notes` were shown, so they don't come back.
  static func markSeen(_ notes: ReleaseNotes) {
    #if DEBUG
      if UserDefaults.standard.bool(forKey: "QaliWhatsNew") { return }
    #endif
    UserDefaults.standard.set(notes.version, forKey: lastSeenKey)
  }
}

/// The sheet: the app's icon and version over the release's points, and a
/// button to carry on.
struct WhatsNewSheet: View {
  let notes: ReleaseNotes
  let done: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      VStack(spacing: 4) {
        Image(nsImage: NSApp.applicationIconImage)
          .resizable()
          .frame(width: 72, height: 72)
          .padding(.bottom, 8)
        Text("What's New in Qali")
          .font(.display(22))
        Text("Version \(notes.version)")
          .font(.sans(TextSize.sm))
          .foregroundStyle(Palette.mutedForeground)
      }
      .padding(.top, 28)
      .padding(.bottom, 20)

      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          ForEach(notes.items) { item in
            VStack(alignment: .leading, spacing: 2) {
              if !item.title.isEmpty {
                Text(item.title)
                  .font(.sans(TextSize.sm, .semibold))
              }
              Text(Self.inline(item.body))
                .font(.sans(TextSize.sm))
                .foregroundStyle(Palette.mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(.horizontal, 32)
        .padding(.bottom, 8)
      }
      .frame(maxHeight: 380)
      .scrollBounceBehavior(.basedOnSize)

      HStack {
        Spacer()
        Button("Continue", action: done)
          .keyboardShortcut(.defaultAction)
          .controlSize(.large)
      }
      .padding(20)
    }
    .frame(width: 480)
    .foregroundStyle(Palette.foreground)
  }

  /// A bullet's inline Markdown (bold, links), or its plain text if that
  /// doesn't parse.
  private static func inline(_ markdown: String) -> AttributedString {
    (try? AttributedString(
      markdown: markdown,
      options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    )) ?? AttributedString(markdown)
  }
}
