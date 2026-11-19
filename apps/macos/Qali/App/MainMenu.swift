import AppKit

/// The menu bar, built in code (there is no nib). Items with a nil target
/// travel the responder chain, ending at the app delegate.
enum MainMenu {
  static func make() -> NSMenu {
    let main = NSMenu()
    main.addItem(holding: appMenu())
    main.addItem(holding: editMenu())
    main.addItem(holding: viewMenu())

    let window = windowMenu()
    main.addItem(holding: window)
    NSApp.windowsMenu = window

    let help = helpMenu()
    main.addItem(holding: help)
    NSApp.helpMenu = help
    return main
  }

  private static func appMenu() -> NSMenu {
    let menu = NSMenu()
    menu.addItem("About Qali", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
    if AppUpdater.shared.isEnabled {
      menu.addItem("Check for Updates…", #selector(AppDelegate.checkForUpdates(_:)))
    }
    menu.addItem(.separator())
    menu.addItem("Settings…", #selector(AppDelegate.showSettings(_:)), ",")
    menu.addItem(.separator())
    menu.addItem("Sign Out", #selector(AppDelegate.signOut(_:)))
    menu.addItem(.separator())

    let services = NSMenu()
    let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
    servicesItem.submenu = services
    menu.addItem(servicesItem)
    NSApp.servicesMenu = services

    menu.addItem(.separator())
    menu.addItem("Hide Qali", #selector(NSApplication.hide(_:)), "h")
    menu.addItem("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
    menu.addItem("Show All", #selector(NSApplication.unhideAllApplications(_:)))
    menu.addItem(.separator())
    menu.addItem("Quit Qali", #selector(NSApplication.terminate(_:)), "q")
    return menu
  }

  private static func editMenu() -> NSMenu {
    let menu = NSMenu(title: "Edit")
    menu.addItem("Undo", Selector(("undo:")), "z")
    menu.addItem("Redo", Selector(("redo:")), "z", [.command, .shift])
    menu.addItem(.separator())
    menu.addItem("Cut", #selector(NSText.cut(_:)), "x")
    menu.addItem("Copy", #selector(NSText.copy(_:)), "c")
    menu.addItem("Paste", #selector(NSText.paste(_:)), "v")
    menu.addItem("Select All", #selector(NSText.selectAll(_:)), "a")
    return menu
  }

  private static func viewMenu() -> NSMenu {
    let menu = NSMenu(title: "View")
    menu.addItem("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
    return menu
  }

  private static func windowMenu() -> NSMenu {
    let menu = NSMenu(title: "Window")
    menu.addItem("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
    menu.addItem("Zoom", #selector(NSWindow.performZoom(_:)))
    menu.addItem(.separator())
    menu.addItem("qali", #selector(AppDelegate.showCalendar(_:)), "1")
    menu.addItem(.separator())
    menu.addItem("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)))
    return menu
  }

  private static func helpMenu() -> NSMenu {
    let menu = NSMenu(title: "Help")
    menu.addItem("Qali Website", #selector(AppDelegate.openWebsite(_:)))
    return menu
  }
}

extension NSMenu {
  fileprivate func addItem(holding submenu: NSMenu) {
    let item = NSMenuItem()
    item.submenu = submenu
    addItem(item)
  }

  @discardableResult
  fileprivate func addItem(
    _ title: String,
    _ action: Selector,
    _ key: String = "",
    _ modifiers: NSEvent.ModifierFlags = .command
  ) -> NSMenuItem {
    let item = addItem(withTitle: title, action: action, keyEquivalent: key)
    item.keyEquivalentModifierMask = modifiers
    return item
  }
}
