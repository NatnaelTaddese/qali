import Foundation
import SwiftUI

/// The assistant's prose as markdown, sized for a bubble (the web's
/// `AssistantMarkdown`): paragraphs, bullet and numbered lists, quotes and
/// code, with inline emphasis, code and links. Headings read as bold lines;
/// a reply never needs document structure. Raw HTML and images are never
/// drawn, and only web links stay tappable, each followed by its host so
/// link text can't pass one address off as another.
struct AssistantMarkdown: View {
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
        view(for: block)
      }
    }
    .fixedSize(horizontal: false, vertical: true)
  }

  @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
    switch block {
    case .paragraph(let line):
      Text(Self.inline(line))
    case .heading(let line):
      Text(Self.inline(line)).fontWeight(.semibold)
    case .list(let items, let ordered):
      VStack(alignment: .leading, spacing: 3) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(ordered ? "\(index + 1)." : "•")
              .monospacedDigit()
              .foregroundStyle(Palette.mutedForeground)
            Text(Self.inline(item))
          }
        }
      }
    case .quote(let line):
      Text(Self.inline(line))
        .foregroundStyle(Palette.mutedForeground)
        .padding(.leading, 8)
        .overlay(alignment: .leading) { Capsule().fill(Palette.border).frame(width: 2) }
    case .code(let code):
      Text(code)
        .font(.system(size: TextSize.xs, design: .monospaced))
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.foreground.opacity(0.08), in: .rect(cornerRadius: 8))
    case .rule:
      Divider()
    }
  }

  /// Inline markdown, with every non-web link dropped and the host shown
  /// after each one that stays.
  static func inline(_ source: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    guard let parsed = try? AttributedString(markdown: source, options: options) else {
      return AttributedString(source)
    }
    var out = AttributedString()
    for run in parsed.runs {
      var piece = AttributedString(parsed[run.range])
      if let code = run.inlinePresentationIntent, code.contains(.code) {
        piece.font = .system(size: TextSize.sm - 1, design: .monospaced)
      }
      if let link = run.link {
        piece.link = nil
        if let scheme = link.scheme?.lowercased(), scheme == "https" || scheme == "http", let host = link.host() {
          piece.link = link
          piece.underlineStyle = .single
          out.append(piece)
          var suffix = AttributedString(" (\(host))")
          suffix.foregroundColor = Palette.mutedForeground
          out.append(suffix)
          continue
        }
      }
      out.append(piece)
    }
    return out
  }
}

enum MarkdownBlock: Equatable {
  case paragraph(String)
  case heading(String)
  case list([String], ordered: Bool)
  case quote(String)
  case code(String)
  case rule

  /// Splits a reply into blocks. Forgiving by design: it runs on every
  /// patch of a streaming reply, so a half-written list or an unclosed fence
  /// must still read sensibly.
  static func parse(_ text: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var paragraph: [String] = []
    var items: [String] = []
    var ordered = false
    var code: [String]?

    func flushParagraph() {
      if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
      paragraph = []
    }
    func flushList() {
      if !items.isEmpty { blocks.append(.list(items, ordered: ordered)) }
      items = []
    }

    for raw in text.components(separatedBy: "\n") {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("```") {
        if let lines = code {
          blocks.append(.code(lines.joined(separator: "\n")))
          code = nil
        } else {
          flushParagraph()
          flushList()
          code = []
        }
        continue
      }
      if code != nil {
        code?.append(raw)
        continue
      }
      if line.isEmpty {
        flushParagraph()
        flushList()
        continue
      }
      if let item = bullet(line) {
        flushParagraph()
        if !items.isEmpty, ordered { flushList() }
        ordered = false
        items.append(item)
        continue
      }
      if let item = numbered(line) {
        flushParagraph()
        if !items.isEmpty, !ordered { flushList() }
        ordered = true
        items.append(item)
        continue
      }
      // A wrapped line continues the item above it.
      if !items.isEmpty, raw.hasPrefix("  ") {
        items[items.count - 1] += " " + line
        continue
      }
      flushList()
      if line.hasPrefix("#") {
        flushParagraph()
        blocks.append(.heading(String(line.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces)))
      } else if line.hasPrefix(">") {
        flushParagraph()
        blocks.append(.quote(String(line.dropFirst()).trimmingCharacters(in: .whitespaces)))
      } else if line == "---" || line == "***" {
        flushParagraph()
        blocks.append(.rule)
      } else {
        paragraph.append(line)
      }
    }
    if let lines = code { blocks.append(.code(lines.joined(separator: "\n"))) }
    flushParagraph()
    flushList()
    return blocks
  }

  private static func bullet(_ line: String) -> String? {
    for marker in ["- ", "* ", "• "] where line.hasPrefix(marker) {
      return String(line.dropFirst(marker.count))
    }
    return nil
  }

  private static func numbered(_ line: String) -> String? {
    let digits = line.prefix(while: \.isNumber)
    guard !digits.isEmpty, digits.count <= 3 else { return nil }
    let rest = line.dropFirst(digits.count)
    guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
    return String(rest.dropFirst(2))
  }
}
