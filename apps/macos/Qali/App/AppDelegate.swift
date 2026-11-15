import AppKit

/// The AppKit shell. Windows, the menu bar and the app lifecycle are AppKit;
/// everything drawn inside a window is SwiftUI, hosted by the window
/// controllers.
@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
  private let model = AppModel()
  private var mainWindow: MainWindowController?

  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    // NSApplication holds its delegate weakly.
    withExtendedLifetime(delegate) { app.run() }
  }

  func applicationWillFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = MainMenu.make()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    showMainWindow()
    Task { await model.restoreSession() }
  }

  /// A calendar keeps running behind a closed window, like Calendar and Mail;
  /// clicking the Dock icon brings the window back.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { showMainWindow() }
    return true
  }

  func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

  private func showMainWindow() {
    let controller = mainWindow ?? MainWindowController(model: model)
    mainWindow = controller
    controller.showWindow(nil)
    NSApp.activate()
  }

  // MARK: - Menu actions

  @objc func signOut(_ sender: Any?) {
    Task { await model.signOut() }
  }

  @objc func openWebsite(_ sender: Any?) {
    NSWorkspace.shared.open(AppConfig.marketingURL)
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(signOut(_:)): model.phase == .signedIn
    default: true
    }
  }
}
