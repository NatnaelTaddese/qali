import AppKit
import SwiftUI

/// The app's one window: an AppKit window whose content view is SwiftUI.
///
/// The content runs under a transparent titlebar, so each screen draws edge to
/// edge and the traffic lights float over it, which is what lets glass in the
/// content sit against the window's own backdrop instead of under a title bar.
final class MainWindowController: NSWindowController {
  init(model: AppModel) {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "Qali"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.toolbarStyle = .unified
    window.backgroundColor = Palette.AppKit.background
    window.minSize = NSSize(width: 520, height: 480)
    window.tabbingMode = .disallowed
    window.isReleasedWhenClosed = false

    let host = NSHostingView(rootView: RootView().environment(model))
    // The window owns its size; SwiftUI's ideal size must not resize it.
    host.sizingOptions = []
    // Lets a screen declare its toolbar in SwiftUI (`.toolbar`) and have it
    // become the window's real NSToolbar, glass and all.
    host.sceneBridgingOptions = [.toolbars]
    window.contentView = host

    window.center()
    window.setFrameAutosaveName("QaliMainWindow")
    super.init(window: window)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("MainWindowController is created in code")
  }
}
