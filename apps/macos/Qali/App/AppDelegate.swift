import AppKit

/// The AppKit shell. Windows, the menu bar and the app lifecycle are AppKit;
/// everything drawn inside a window is SwiftUI, hosted by the window
/// controllers.
@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
  private let model = AppModel()
  private var mainWindow: MainWindowController?
  private var settingsWindow: SettingsWindowController?
  private var menuBar: MenuBarController?

  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    // NSApplication holds its delegate weakly.
    withExtendedLifetime(delegate) { app.run() }
  }

  func applicationWillFinishLaunching(_ notification: Notification) {
    MenuBarPrefs.registerDefaults()
    NSApp.mainMenu = MainMenu.make()
    AppTheme.stored.apply()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    showMainWindow()
    Task { await model.restoreSession() }
    AppUpdater.shared.revealApp = { [weak self] in self?.showMainWindow() }
    AppUpdater.shared.start()
    menuBar = MenuBarController(
      model: model,
      openApp: { [weak self] in self?.showMainWindow() },
      openSettings: { [weak self] in self?.showSettings(nil) }
    )
    // With the companion on, closing the last window can drop the Dock icon;
    // opening a window brings it back.
    NotificationCenter.default.addObserver(
      forName: NSWindow.willCloseNotification, object: nil, queue: .main
    ) { [weak self] note in
      let id = (note.object as? NSWindow).map(ObjectIdentifier.init)
      MainActor.assumeIsolated { self?.windowWillClose(id) }
    }
    #if DEBUG
      // `-QaliSettings general|accounts|calendars|dateTime|events` opens the
      // Settings window on that pane, for a capture.
      if let pane = UserDefaults.standard.string(forKey: "QaliSettings").flatMap(SettingsPane.init(rawValue:)) {
        showSettings(nil)
        settingsWindow?.navigation.show(pane)
      }
      // `-QaliMenuBar open` opens the companion's panel at launch.
      if UserDefaults.standard.string(forKey: "QaliMenuBar") == "open" {
        Task {
          try? await Task.sleep(for: .seconds(3))
          menuBar?.open()
        }
      }
    #endif
  }

  /// A calendar keeps running behind a closed window, like Calendar and Mail;
  /// clicking the Dock icon brings the window back.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { showMainWindow() }
    return true
  }

  func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

  private func windowWillClose(_ closing: ObjectIdentifier?) {
    guard MenuBarPrefs.isEnabled, MenuBarPrefs.hidesDockIcon else { return }
    let others = [mainWindow?.window, settingsWindow?.window].compactMap { $0 }
      .filter { ObjectIdentifier($0) != closing && $0.isVisible }
    if others.isEmpty { NSApp.setActivationPolicy(.accessory) }
  }

  private func showMainWindow() {
    NSApp.setActivationPolicy(.regular)
    let controller = mainWindow ?? MainWindowController(model: model)
    mainWindow = controller
    controller.showWindow(nil)
    NSApp.activate()
  }

  // MARK: - Menu actions

  @objc func showCalendar(_ sender: Any?) { showMainWindow() }

  @objc func showSettings(_ sender: Any?) {
    NSApp.setActivationPolicy(.regular)
    let controller = settingsWindow ?? SettingsWindowController(model: model)
    settingsWindow = controller
    controller.showWindow(nil)
    controller.window?.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  @objc func checkForUpdates(_ sender: Any?) {
    AppUpdater.shared.checkForUpdates()
  }

  @objc func signOut(_ sender: Any?) {
    Task { await model.signOut() }
  }

  @objc func openWebsite(_ sender: Any?) {
    NSWorkspace.shared.open(AppConfig.marketingURL)
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    switch item.action {
    case #selector(signOut(_:)): model.phase == .signedIn
    case #selector(checkForUpdates(_:)): AppUpdater.shared.canCheckForUpdates
    default: true
    }
  }
}
