import AppKit
import Observation
import OSLog
import SwiftUI

/// The description editor (the web's TipTap `RichTextEditor`), limited to
/// what Google Calendar keeps in a description: bold, italic, underline,
/// links, and bulleted and numbered lists. It is an `NSTextView`, so typing,
/// undo, spelling and list continuation on Return are the system's; the
/// toolbar applies the formats and `DescriptionHTML` writes the result as the
/// HTML subset the web sends.
@Observable
final class RichTextController {
  enum ListKind { case bullet, number }

  /// The formats at the selection, for the toolbar's pressed states.
  private(set) var bold = false
  private(set) var italic = false
  private(set) var underline = false
  private(set) var link: String?
  private(set) var list: ListKind?

  @ObservationIgnored weak var textView: NSTextView?

  /// Lexend has no italic cut: italic is drawn slanted, and the slant is what
  /// marks it.
  static let obliqueness: CGFloat = 0.18
  static let size: CGFloat = TextSize.base

  static var regular: NSFont { NSFont(name: "Lexend-Regular", size: size) ?? .systemFont(ofSize: size) }
  static var boldFont: NSFont { NSFont(name: "Lexend-SemiBold", size: size) ?? .boldSystemFont(ofSize: size) }

  static func isBold(_ font: NSFont?) -> Bool {
    guard let font else { return false }
    return font.fontName.contains("Bold") || font.fontDescriptor.symbolicTraits.contains(.bold)
  }

  static var baseAttributes: [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 2
    paragraph.paragraphSpacing = 4
    return [.font: regular, .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph]
  }

  // MARK: Selection state

  func refresh() {
    guard let textView, let storage = textView.textStorage else { return }
    let range = textView.selectedRange()
    let attributes: [NSAttributedString.Key: Any]
    if range.length == 0 {
      attributes = textView.typingAttributes
    } else {
      attributes = storage.attributes(at: range.location, effectiveRange: nil)
    }
    bold = range.length > 0 ? all(in: range) { Self.isBold($0[.font] as? NSFont) } : Self.isBold(attributes[.font] as? NSFont)
    italic = range.length > 0 ? all(in: range) { Self.isItalic($0) } : Self.isItalic(attributes)
    underline = range.length > 0 ? all(in: range) { Self.isUnderlined($0) } : Self.isUnderlined(attributes)
    link = linkAt(range)
    list = Self.listKind(of: paragraphStyle(at: range.location))
  }

  private func all(in range: NSRange, _ test: ([NSAttributedString.Key: Any]) -> Bool) -> Bool {
    guard let storage = textView?.textStorage else { return false }
    var result = true
    storage.enumerateAttributes(in: range) { attributes, _, stop in
      if !test(attributes) {
        result = false
        stop.pointee = true
      }
    }
    return result
  }

  static func isItalic(_ attributes: [NSAttributedString.Key: Any]) -> Bool {
    ((attributes[.obliqueness] as? NSNumber)?.doubleValue ?? 0) > 0
  }

  static func isUnderlined(_ attributes: [NSAttributedString.Key: Any]) -> Bool {
    ((attributes[.underlineStyle] as? NSNumber)?.intValue ?? 0) != 0
  }

  static func href(_ value: Any?) -> String? {
    switch value {
    case let url as URL: url.absoluteString
    case let string as String: string
    default: nil
    }
  }

  private func linkAt(_ range: NSRange) -> String? {
    guard let storage = textView?.textStorage, storage.length > 0 else { return nil }
    let location = min(range.length > 0 ? range.location : max(range.location - 1, 0), storage.length - 1)
    return Self.href(storage.attribute(.link, at: location, effectiveRange: nil))
  }

  private func paragraphStyle(at location: Int) -> NSParagraphStyle? {
    guard let textView, let storage = textView.textStorage else { return nil }
    if storage.length == 0 || location >= storage.length {
      // At the very end the next character typed takes the typing style;
      // a list item ending the text is still that list's.
      if location > 0, location == storage.length,
        let style = storage.attribute(.paragraphStyle, at: location - 1, effectiveRange: nil) as? NSParagraphStyle,
        !(storage.string as NSString).substring(with: NSRange(location: location - 1, length: 1)).hasSuffix("\n")
      {
        return style
      }
      return textView.typingAttributes[.paragraphStyle] as? NSParagraphStyle
    }
    return storage.attribute(.paragraphStyle, at: location, effectiveRange: nil) as? NSParagraphStyle
  }

  static func listKind(of style: NSParagraphStyle?) -> ListKind? {
    guard let list = style?.textLists.last else { return nil }
    return list.markerFormat == .disc ? .bullet : .number
  }

  // MARK: Inline formats

  func toggleBold() {
    applyInline(!bold) { attributes, on in
      let font = attributes[.font] as? NSFont
      return [.font: on ? Self.boldFont : Self.regular.withSize(font?.pointSize ?? Self.size)]
    } typing: { typing, on in
      typing[.font] = on ? Self.boldFont : Self.regular
    }
  }

  func toggleItalic() {
    applyInline(!italic) { _, on in
      [.obliqueness: on ? Self.obliqueness : 0]
    } typing: { typing, on in
      typing[.obliqueness] = on ? Self.obliqueness : nil
    }
  }

  func toggleUnderline() {
    applyInline(!underline) { _, on in
      [.underlineStyle: on ? NSUnderlineStyle.single.rawValue : 0]
    } typing: { typing, on in
      typing[.underlineStyle] = on ? NSUnderlineStyle.single.rawValue : nil
    }
  }

  /// Sets a format on the selection, or on what is typed next when nothing is
  /// selected.
  private func applyInline(
    _ on: Bool,
    _ attributes: ([NSAttributedString.Key: Any], Bool) -> [NSAttributedString.Key: Any],
    typing: (inout [NSAttributedString.Key: Any], Bool) -> Void
  ) {
    guard let textView, let storage = textView.textStorage else { return }
    textView.window?.makeFirstResponder(textView)
    let range = textView.selectedRange()
    if range.length == 0 {
      var next = textView.typingAttributes
      typing(&next, on)
      textView.typingAttributes = next
    } else if textView.shouldChangeText(in: range, replacementString: nil) {
      storage.beginEditing()
      storage.enumerateAttributes(in: range) { current, run, _ in
        for (key, value) in attributes(current, on) {
          if let number = value as? NSNumber, number.doubleValue == 0, key != .font {
            storage.removeAttribute(key, range: run)
          } else {
            storage.addAttribute(key, value: value, range: run)
          }
        }
      }
      storage.endEditing()
      textView.didChangeText()
    }
    refresh()
  }

  // MARK: Links

  /// Links the selection (or the link under the caret) to `raw`; an empty
  /// value removes the link. With nothing selected, the address goes in as
  /// its own linked text.
  func setLink(_ raw: String) {
    guard let textView, let storage = textView.textStorage else { return }
    textView.window?.makeFirstResponder(textView)
    var range = textView.selectedRange()
    // The whole link under the caret, so editing it changes all of it.
    if range.length == 0, storage.length > 0 {
      let location = min(max(range.location - 1, 0), storage.length - 1)
      var effective = NSRange()
      if storage.attribute(.link, at: location, longestEffectiveRange: &effective, in: NSRange(location: 0, length: storage.length)) != nil {
        range = effective
      }
    }
    let href = Self.normalizeURL(raw)
    if href.isEmpty {
      guard range.length > 0, textView.shouldChangeText(in: range, replacementString: nil) else { return }
      storage.removeAttribute(.link, range: range)
      textView.didChangeText()
    } else if range.length == 0 {
      var attributes = textView.typingAttributes
      attributes[.link] = href
      let inserted = NSAttributedString(string: href, attributes: attributes)
      guard textView.shouldChangeText(in: range, replacementString: href) else { return }
      storage.replaceCharacters(in: range, with: inserted)
      textView.didChangeText()
      textView.setSelectedRange(NSRange(location: range.location + inserted.length, length: 0))
      textView.typingAttributes[.link] = nil
    } else {
      guard textView.shouldChangeText(in: range, replacementString: nil) else { return }
      storage.addAttribute(.link, value: href, range: range)
      textView.didChangeText()
    }
    refresh()
  }

  /// Bare hosts get https://; http(s) and mailto are kept (the web's
  /// `normalizeUrl`).
  static func normalizeURL(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "" }
    if trimmed.range(of: "^(https?://|mailto:)", options: [.regularExpression, .caseInsensitive]) != nil { return trimmed }
    return "https://\(trimmed)"
  }

  // MARK: Lists

  /// The marker text AppKit keeps at the start of a list item.
  static let markerPattern = "^\t[^\t\n]*\t"

  /// Turns the paragraphs in the selection into a list of `kind`, or back
  /// into plain paragraphs when they already are one. The markers are text,
  /// as AppKit's own lists keep them, so Return continues the list and Return
  /// on an empty item ends it.
  func toggleList(_ kind: ListKind) {
    guard let textView, let storage = textView.textStorage else { return }
    textView.window?.makeFirstResponder(textView)
    let text = storage.string as NSString
    let selection = textView.selectedRange()
    let whole = text.paragraphRange(for: selection)
    var paragraphs: [NSRange] = []
    text.enumerateSubstrings(in: whole, options: [.byParagraphs, .substringNotRequired]) { _, range, _, _ in
      paragraphs.append(range)
    }
    if paragraphs.isEmpty { paragraphs = [NSRange(location: whole.location, length: 0)] }

    let removing = list == kind
    let textList = NSTextList(markerFormat: kind == .bullet ? .disc : .decimal, options: 0)
    let style = NSMutableParagraphStyle()
    style.setParagraphStyle(Self.baseAttributes[.paragraphStyle] as! NSParagraphStyle)
    if !removing {
      style.textLists = [textList]
      style.tabStops = [NSTextTab(textAlignment: .natural, location: 6), NSTextTab(textAlignment: .natural, location: 22)]
      style.headIndent = 22
    }

    guard textView.shouldChangeText(in: whole, replacementString: nil) else { return }
    storage.beginEditing()
    var caretShift = 0
    // Back to front, so the earlier ranges stay put as markers come and go.
    for (index, paragraph) in paragraphs.enumerated().reversed() {
      let current = (storage.string as NSString).substring(with: paragraph)
      let existing = current.range(of: Self.markerPattern, options: .regularExpression).map { NSRange($0, in: current).length } ?? 0
      let marker = removing ? "" : "\t\(textList.marker(forItemNumber: index + 1))\t"
      var attributes = storage.length > 0
        ? storage.attributes(at: min(paragraph.location, storage.length - 1), effectiveRange: nil)
        : textView.typingAttributes
      attributes[.link] = nil
      attributes[.paragraphStyle] = style
      storage.replaceCharacters(
        in: NSRange(location: paragraph.location, length: existing),
        with: NSAttributedString(string: marker, attributes: attributes)
      )
      let full = NSRange(location: paragraph.location, length: paragraph.length - existing + marker.utf16.count)
      if full.length > 0 { storage.addAttribute(.paragraphStyle, value: style, range: full) }
      if paragraph.location <= selection.location { caretShift += marker.utf16.count - existing }
    }
    storage.endEditing()
    var typing = textView.typingAttributes
    typing[.paragraphStyle] = style
    textView.typingAttributes = typing
    textView.didChangeText()
    let location = max(selection.location + caretShift, 0)
    textView.setSelectedRange(NSRange(location: min(location, storage.length), length: selection.length))
    refresh()
  }
}

// MARK: - HTML

/// The editor's text as Google Calendar's description HTML: `<p>` per line,
/// `<ul>`/`<ol>` with `<li>` per list item, and `<b>`, `<i>`, `<u>` and
/// `<a href>` inside. Nil when there is nothing but whitespace.
enum DescriptionHTML {
  static func html(from text: NSAttributedString) -> String? {
    let blocks = paragraphs(of: text)
    guard blocks.contains(where: { !$0.plain.trimmingCharacters(in: .whitespaces).isEmpty }) else { return nil }
    // No empty lines at either end.
    let first = blocks.firstIndex { !$0.plain.trimmingCharacters(in: .whitespaces).isEmpty }!
    let last = blocks.lastIndex { !$0.plain.trimmingCharacters(in: .whitespaces).isEmpty }!

    var html = ""
    var open: RichTextController.ListKind?
    for block in blocks[first...last] {
      if block.list != open {
        if let open { html += open == .bullet ? "</ul>" : "</ol>" }
        if let list = block.list { html += list == .bullet ? "<ul>" : "<ol>" }
        open = block.list
      }
      html += block.list == nil ? "<p>\(block.html)</p>" : "<li>\(block.html)</li>"
    }
    if let open { html += open == .bullet ? "</ul>" : "</ol>" }
    return html
  }

  /// One line, as plain text for the form's preview.
  static func preview(from text: NSAttributedString) -> String {
    paragraphs(of: text)
      .map(\.plain)
      .joined(separator: " ")
      .components(separatedBy: .whitespacesAndNewlines)
      .filter { !$0.isEmpty }
      .joined(separator: " ")
  }

  private struct Block {
    var list: RichTextController.ListKind?
    var html: String
    var plain: String
  }

  private static func paragraphs(of text: NSAttributedString) -> [Block] {
    let string = text.string as NSString
    var blocks: [Block] = []
    string.enumerateSubstrings(
      in: NSRange(location: 0, length: string.length),
      options: [.byParagraphs, .substringNotRequired]
    ) { _, range, _, _ in
      var content = range
      var list: RichTextController.ListKind?
      if range.length > 0 {
        let style = text.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle
        list = RichTextController.listKind(of: style)
        let line = string.substring(with: range)
        if list != nil, let marker = line.range(of: RichTextController.markerPattern, options: .regularExpression) {
          let length = NSRange(marker, in: line).length
          content = NSRange(location: range.location + length, length: range.length - length)
        }
      }
      blocks.append(Block(list: list, html: inline(text, content), plain: string.substring(with: content)))
    }
    return blocks
  }

  private static func inline(_ text: NSAttributedString, _ range: NSRange) -> String {
    guard range.length > 0 else { return "" }
    var html = ""
    text.enumerateAttributes(in: range) { attributes, run, _ in
      var piece = escape((text.string as NSString).substring(with: run))
      if RichTextController.isUnderlined(attributes) { piece = "<u>\(piece)</u>" }
      if RichTextController.isItalic(attributes) { piece = "<i>\(piece)</i>" }
      if RichTextController.isBold(attributes[.font] as? NSFont) { piece = "<b>\(piece)</b>" }
      if let href = RichTextController.href(attributes[.link]) {
        piece = "<a href=\"\(escape(href, quotes: true))\">\(piece)</a>"
      }
      html += piece
    }
    return html
  }

  private static func escape(_ text: String, quotes: Bool = false) -> String {
    var escaped = text
      .replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
    if quotes { escaped = escaped.replacingOccurrences(of: "\"", with: "&quot;") }
    return escaped
  }
}

// MARK: - Text view

/// The editing surface: a plain, transparent `NSTextView` in a scroll view.
struct RichTextEditor: NSViewRepresentable {
  let initial: NSAttributedString
  let controller: RichTextController
  let onChange: (NSAttributedString) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(controller: controller, onChange: onChange) }

  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.scrollerStyle = .overlay
    // TextKit 1, as TextEdit: TextKit 2 left a list item's text undrawn after
    // the list was applied, and did not draw the italic slant.
    let plainPaste = PlainPasteTextView(usingTextLayoutManager: false)
    plainPaste.autoresizingMask = [.width]
    plainPaste.minSize = .zero
    plainPaste.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
    plainPaste.isVerticallyResizable = true
    plainPaste.isHorizontallyResizable = false
    plainPaste.textContainer?.widthTracksTextView = true
    plainPaste.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
    scroll.documentView = plainPaste

    plainPaste.drawsBackground = false
    plainPaste.isRichText = true
    plainPaste.importsGraphics = false
    plainPaste.allowsUndo = true
    plainPaste.usesFontPanel = false
    plainPaste.isAutomaticLinkDetectionEnabled = true
    plainPaste.isAutomaticQuoteSubstitutionEnabled = false
    plainPaste.textContainerInset = NSSize(width: 0, height: 2)
    plainPaste.textContainer?.lineFragmentPadding = 0
    plainPaste.typingAttributes = RichTextController.baseAttributes
    plainPaste.linkTextAttributes = [
      .foregroundColor: NSColor.linkColor,
      .underlineStyle: NSUnderlineStyle.single.rawValue,
      .cursor: NSCursor.pointingHand,
    ]
    plainPaste.textStorage?.setAttributedString(initial)
    plainPaste.delegate = context.coordinator
    controller.textView = plainPaste
    controller.refresh()
    // Once the page is in its window: the caret goes to the end, ready to type.
    DispatchQueue.main.async {
      plainPaste.window?.makeFirstResponder(plainPaste)
      plainPaste.setSelectedRange(NSRange(location: plainPaste.string.utf16.count, length: 0))
    }
    return scroll
  }

  func updateNSView(_ view: NSScrollView, context: Context) {
    context.coordinator.onChange = onChange
  }

  final class Coordinator: NSObject, NSTextViewDelegate {
    let controller: RichTextController
    var onChange: (NSAttributedString) -> Void

    init(controller: RichTextController, onChange: @escaping (NSAttributedString) -> Void) {
      self.controller = controller
      self.onChange = onChange
    }

    func textDidChange(_ notification: Notification) {
      guard let textView = notification.object as? NSTextView, let storage = textView.textStorage else { return }
      onChange(NSAttributedString(attributedString: storage))
      controller.refresh()
    }

    func textViewDidChangeSelection(_ notification: Notification) {
      controller.refresh()
    }
  }
}

/// Pastes as plain text in the typing style: formatting from elsewhere is not
/// formatting Google keeps.
private final class PlainPasteTextView: NSTextView {
  override func paste(_ sender: Any?) { pasteAsPlainText(sender) }
}

// MARK: - Page

/// The create form's description screen (the web's drill-down): back to the
/// form under the event's title, the format toolbar, and the editor filling
/// the rest of the panel.
struct DescriptionPage: View {
  let title: String
  let initial: NSAttributedString
  let back: () -> Void
  let onChange: (NSAttributedString) -> Void

  @State private var controller = RichTextController()
  @State private var isEmpty: Bool

  init(title: String, initial: NSAttributedString, back: @escaping () -> Void, onChange: @escaping (NSAttributedString) -> Void) {
    self.title = title
    self.initial = initial
    self.back = back
    self.onChange = onChange
    _isEmpty = State(initialValue: initial.length == 0)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        BackButton(title: title, action: back)
        Spacer(minLength: 0)
      }

      FormatToolbar(controller: controller)

      RichTextEditor(initial: initial, controller: controller) { text in
        isEmpty = text.length == 0
        onChange(text)
      }
      .overlay(alignment: .topLeading) {
        if isEmpty {
          Text("Add description")
            .font(.sans(RichTextController.size))
            .foregroundStyle(Palette.mutedForeground)
            .padding(.top, 2)
            .allowsHitTesting(false)
        }
      }
      .frame(maxHeight: .infinity)
    }
    #if DEBUG
      .task {
        guard UserDefaults.standard.string(forKey: "QaliDescription") == "demo" else { return }
        try? await Task.sleep(for: .seconds(0.8))
        guard let view = controller.textView else { return }
        func type(_ text: String) { view.insertText(text, replacementRange: view.selectedRange()) }
        type("Agenda for the review")
        view.setSelectedRange(NSRange(location: 0, length: 6))
        controller.toggleBold()
        view.setSelectedRange(NSRange(location: view.string.utf16.count, length: 0))
        view.insertNewline(nil)
        controller.toggleList(.bullet)
        type("Intro and goals")
        view.insertNewline(nil)
        type("Demo of the ")
        controller.toggleItalic()
        type("new grid")
        controller.toggleItalic()
        view.insertNewline(nil)
        view.insertNewline(nil)
        type("Notes: ")
        controller.setLink("qali.app")
        Logger(subsystem: "com.myqali.macos", category: "notes")
          .notice("DESC \(DescriptionHTML.html(from: view.attributedString()) ?? "nil", privacy: .public)")
        // Then back to the form, to see its preview line.
        try? await Task.sleep(for: .seconds(2))
        back()
      }
    #endif
    // Escape returns to the form rather than closing it.
    .background {
      Button("Back", action: back)
        .keyboardShortcut(.cancelAction)
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
  }
}

private struct BackButton: View {
  let title: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 4) {
        Image(systemName: "chevron.left")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Palette.mutedForeground)
        Text(title)
          .font(.sans(TextSize.sm, .semibold))
          .lineLimit(1)
      }
      .padding(.horizontal, 6)
      .padding(.vertical, 4)
      .background {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Palette.foreground.opacity(hovering ? 0.08 : 0))
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .padding(.leading, -6)
    .onHover { hovering = $0 }
    .help("Back to the event (Esc)")
  }
}

/// Bold, italic, underline · link · bullets, numbers: Google's formats.
private struct FormatToolbar: View {
  let controller: RichTextController
  @State private var linkOpen = false
  @State private var linkText = ""

  var body: some View {
    VStack(spacing: 8) {
      HStack(spacing: 2) {
        FormatButton(symbol: "bold", label: "Bold", shortcut: "b", active: controller.bold, action: controller.toggleBold)
        FormatButton(symbol: "italic", label: "Italic", shortcut: "i", active: controller.italic, action: controller.toggleItalic)
        FormatButton(symbol: "underline", label: "Underline", shortcut: "u", active: controller.underline, action: controller.toggleUnderline)
        divider
        FormatButton(symbol: "link", label: "Link", shortcut: "k", active: controller.link != nil) {
          linkText = controller.link ?? ""
          linkOpen = true
        }
        .popover(isPresented: $linkOpen, arrowEdge: .top) { linkEditor }
        divider
        FormatButton(symbol: "list.bullet", label: "Bulleted list", shortcut: nil, active: controller.list == .bullet) {
          controller.toggleList(.bullet)
        }
        FormatButton(symbol: "list.number", label: "Numbered list", shortcut: nil, active: controller.list == .number) {
          controller.toggleList(.number)
        }
        Spacer(minLength: 0)
      }
      Palette.border.frame(height: 1)
    }
  }

  private var divider: some View {
    Palette.border.frame(width: 1, height: 18).padding(.horizontal, 4)
  }

  private var linkEditor: some View {
    HStack(spacing: 6) {
      TextField("https://example.com", text: $linkText)
        .textFieldStyle(.roundedBorder)
        .frame(width: 200)
        .onSubmit(applyLink)
      Button(controller.link != nil && linkText.trimmingCharacters(in: .whitespaces).isEmpty ? "Remove" : "Apply", action: applyLink)
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
    }
    .padding(10)
  }

  private func applyLink() {
    controller.setLink(linkText)
    linkOpen = false
  }
}

private struct FormatButton: View {
  let symbol: String
  let label: String
  let shortcut: KeyEquivalent?
  let active: Bool
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    let button = Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(active || hovering ? Palette.foreground : Palette.mutedForeground)
        .frame(width: 28, height: 28)
        .background {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Palette.foreground.opacity(active ? 0.1 : hovering ? 0.06 : 0))
        }
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .help(shortcut.map { "\(label) (⌘\(String($0.character).uppercased()))" } ?? label)
    .accessibilityLabel(label)
    .accessibilityAddTraits(active ? .isSelected : [])
    if let shortcut {
      button.keyboardShortcut(shortcut, modifiers: .command)
    } else {
      button
    }
  }
}
