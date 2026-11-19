import AppKit
import SwiftUI

/// The Settings window (⌘,): a stock sidebar + grouped form, like System
/// Settings. Its toolbar (back/forward and the pane title) is declared in
/// SwiftUI and bridged to the window's NSToolbar.
final class SettingsWindowController: NSWindowController, NSWindowDelegate {
  let navigation = SettingsNavigation()

  init(model: AppModel) {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 760, height: 560),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "Settings"
    window.toolbarStyle = .unified
    window.minSize = NSSize(width: 640, height: 420)
    window.tabbingMode = .disallowed
    window.isReleasedWhenClosed = false
    window.collectionBehavior.insert(.fullScreenNone)

    let host = NSHostingView(
      rootView: SettingsView()
        .environment(model)
        .environment(navigation)
    )
    host.sizingOptions = []
    host.sceneBridgingOptions = [.toolbars, .title]
    window.contentView = host

    window.center()
    window.setFrameAutosaveName("QaliSettingsWindow")
    super.init(window: window)
    window.delegate = self
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("SettingsWindowController is created in code")
  }
}
