import AppKit
import SwiftUI

/// The menu bar companion: a status item drawing `MenuBarLabel`, and a
/// Liquid Glass panel (`MenuBarPanel`) that drops from it the way Control
/// Center's Wi-Fi or Sound menus do: no arrow, top-anchored under the item,
/// following the menu bar's appearance. Shown while "Show qali in the menu
/// bar" is on.
@MainActor
final class MenuBarController: NSObject {
  private let model: AppModel
  private let actions: MenuBarActions
  private var item: NSStatusItem?
  private var panel: MenuBarWindow?
  private var outsideClicks: Any?
  private var escapeKey: Any?
  private var defaultsObserver: NSObjectProtocol?
  /// When the panel last closed; a click on the item that closed it (by
  /// taking key) must not reopen it straight away.
  private var closedAt = Date.distantPast

  init(model: AppModel, openApp: @escaping () -> Void, openSettings: @escaping () -> Void) {
    self.model = model
    self.actions = MenuBarActions(
      openApp: openApp,
      openSettings: openSettings,
      quit: { NSApp.terminate(nil) }
    )
    super.init()
    sync()
    defaultsObserver = NotificationCenter.default.addObserver(
      forName: UserDefaults.didChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.sync() }
    }
  }

  /// Adds or removes the status item to match the setting.
  private func sync() {
    if MenuBarPrefs.isEnabled {
      if item == nil { install() }
    } else if let item {
      close()
      NSStatusBar.system.removeStatusItem(item)
      self.item = nil
    }
  }

  private func install() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.autosaveName = "QaliMenuBar"
    guard let button = item.button else { return }
    button.target = self
    button.action = #selector(toggle(_:))
    button.setAccessibilityLabel("qali")

    let host = PassThroughHostingView(
      rootView: MenuBarLabel()
        .environment(model)
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { [weak item] width in
          item?.length = ceil(width)
        }
    )
    host.translatesAutoresizingMaskIntoConstraints = false
    button.addSubview(host)
    NSLayoutConstraint.activate([
      host.centerXAnchor.constraint(equalTo: button.centerXAnchor),
      host.centerYAnchor.constraint(equalTo: button.centerYAnchor),
    ])
    self.item = item
  }

  @objc private func toggle(_ sender: Any?) {
    if panel?.isVisible == true {
      close()
    } else if Date.now.timeIntervalSince(closedAt) > 0.25 {
      open()
    }
  }

  func open() {
    guard let button = item?.button, let buttonWindow = button.window else { return }
    let panel = self.panel ?? makePanel()
    self.panel = panel
    // Menu bar extras follow the menu bar, not the app's theme.
    panel.appearance = button.effectiveAppearance
    let anchor = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
    panel.anchor = anchor
    panel.place()
    panel.alphaValue = 0
    panel.makeKeyAndOrderFront(nil)
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.12
      panel.animator().alphaValue = 1
    }
    button.highlight(true)

    // The app usually isn't active, so clicks in other apps never reach it;
    // a nonactivating panel losing key covers clicks in our own windows.
    outsideClicks = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      MainActor.assumeIsolated { self?.close() }
    }
    // Escape and the footer's shortcuts. The app is usually inactive, so
    // the main menu never sees these key equivalents.
    escapeKey = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      let keyCode = event.keyCode
      let command = event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command
      let key = event.charactersIgnoringModifiers
      let handled = MainActor.assumeIsolated { self?.handleKey(keyCode, command: command, key: key) ?? false }
      return handled ? nil : event
    }
  }

  /// True when the key was the panel's: Escape, or a footer shortcut.
  private func handleKey(_ keyCode: UInt16, command: Bool, key: String?) -> Bool {
    guard panel?.isKeyWindow == true else { return false }
    if keyCode == 53 {
      close()
      return true
    }
    guard command else { return false }
    switch key {
    case "1": close(); actions.openApp()
    case ",": close(); actions.openSettings()
    case "q": actions.quit()
    default: return false
    }
    return true
  }

  func close() {
    guard let panel, panel.isVisible else { return }
    closedAt = .now
    NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.1
      panel.animator().alphaValue = 0
    } completionHandler: {
      MainActor.assumeIsolated { panel.orderOut(nil) }
    }
    item?.button?.highlight(false)
    if let outsideClicks { NSEvent.removeMonitor(outsideClicks) }
    if let escapeKey { NSEvent.removeMonitor(escapeKey) }
    outsideClicks = nil
    escapeKey = nil
  }

  private func makePanel() -> MenuBarWindow {
    let wrapped = MenuBarActions(
      openApp: { [weak self] in self?.close(); self?.actions.openApp() },
      openSettings: { [weak self] in self?.close(); self?.actions.openSettings() },
      quit: actions.quit
    )
    let panel = MenuBarWindow()
    let host = NSHostingView(
      rootView: MenuBarPanel(actions: wrapped)
        .environment(model)
        .onGeometryChange(for: CGSize.self, of: \.size) { [weak panel] size in
          panel?.contentSize = size
          panel?.place()
        }
    )
    host.sizingOptions = []
    // AppKit's own Liquid Glass, as Control Center's menus use: it draws the
    // material, the edge highlight and follows the system's glass settings
    // (Reduce Transparency, Clear/Tinted); the window shadow follows its shape.
    let glass = NSGlassEffectView()
    glass.cornerRadius = MenuBarPanel.cornerRadius
    glass.contentView = host
    // Leave the corners truly empty, so the window server traces the shadow
    // from the rounded shape rather than the window's square frame.
    glass.wantsLayer = true
    glass.layer?.cornerRadius = MenuBarPanel.cornerRadius
    glass.layer?.cornerCurve = .continuous
    glass.layer?.masksToBounds = true
    panel.contentView = glass
    panel.onResignKey = { [weak self] in self?.close() }
    return panel
  }
}

/// A borderless, nonactivating panel: it can take key (for hover and Escape)
/// without bringing qali's other windows forward.
final class MenuBarWindow: NSPanel {
  /// The status item's frame on screen; the panel hangs under it.
  var anchor: NSRect = .zero
  var contentSize: CGSize = .zero
  var onResignKey: (() -> Void)?

  init() {
    super.init(
      contentRect: .zero,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: true
    )
    isFloatingPanel = true
    level = .popUpMenu
    backgroundColor = .clear
    isOpaque = false
    // The system's menu shadow, traced from the glass's rounded shape.
    hasShadow = true
    hidesOnDeactivate = false
    isReleasedWhenClosed = false
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
  }

  override var canBecomeKey: Bool { true }

  override func resignKey() {
    super.resignKey()
    onResignKey?()
  }

  /// Top edge 4pt under the menu bar, left edge on the item's (as system
  /// menus do), kept on screen.
  func place() {
    guard contentSize.width > 0 else { return }
    let screen = NSScreen.screens.first { $0.frame.intersects(anchor) } ?? NSScreen.main
    let visible = screen?.visibleFrame ?? .zero
    var x = anchor.minX - 6
    x = min(max(x, visible.minX + 8), visible.maxX - contentSize.width - 8)
    let y = anchor.minY - 4 - contentSize.height
    setFrame(NSRect(x: x, y: y, width: contentSize.width, height: contentSize.height), display: true)
    // Re-trace the shadow from the rounded glass after a resize.
    invalidateShadow()
  }
}

/// A hosting view that lets clicks through to the status item's button.
private final class PassThroughHostingView<Content: View>: NSHostingView<Content> {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
