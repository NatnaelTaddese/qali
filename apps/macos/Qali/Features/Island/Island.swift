import AppKit
import Observation
import SwiftUI

/// What the bottom island is showing, the web's `DockView`. With no view it
/// is the nav row.
enum IslandView: Equatable {
  case account
  case search
  case event(CalendarEvent)
  /// The create form; its draft lives on the island, so the ghost on the
  /// grid can follow the times as they are edited.
  case create

  /// Each view's own width, so the shell visibly adapts to what it holds
  /// (the web's `widthClass`).
  var width: CGFloat {
    switch self {
    case .account: 280
    case .search, .event: 390
    case .create: 400
    }
  }

  /// What identifies the face on show; a change swaps the island's content.
  var id: String {
    switch self {
    case .account: "account"
    case .search: "search"
    case .event(let event): "event:\(event.id)"
    case .create: "create"
    }
  }
}

/// The bottom island's state: one shell that is either the nav row or a panel.
@Observable
final class Island {
  private(set) var view: IslandView?
  /// The event being created while the create form is open.
  var draft: EventDraft?
  /// True while the guest matches float over the form: Escape then closes
  /// them, not the form.
  var guestMatchesOpen = false
  /// The island's shell in global coordinates, so the grid can keep a new
  /// event's ghost out from under it.
  var shellFrame: CGRect = .zero
  /// Counts every open and close, so a deferred close can tell that
  /// something else has happened since it was asked for.
  @ObservationIgnored private(set) var changes = 0

  /// The web's `SPRING_DOCK`: firm enough to feel physical, not bouncy.
  static let spring = Animation.interpolatingSpring(mass: 0.9, stiffness: 380, damping: 34)

  func open(_ next: IslandView) {
    changes += 1
    guard view != next else { return }
    withAnimation(Self.spring) { view = next }
  }

  func close() {
    changes += 1
    guard view != nil else { return }
    // The draft stays until the next create replaces it: the form is still
    // on screen while it animates out.
    withAnimation(Self.spring) { view = nil }
  }

  /// True while a panel with a text field is up: the calendar's bare-key
  /// shortcuts (D, W, M, T, arrows) must leave the typing alone.
  var isTyping: Bool { view == .search || view == .create }

  /// Opens the create form on a range. With the form already open, only the
  /// range moves, as on the web: a fresh drag on the grid keeps the title
  /// and everything else typed so far.
  func openCreate(startMs: Double, endMs: Double) {
    if view == .create, var current = draft {
      changes += 1
      current.startMs = startMs
      current.endMs = endMs
      current.allDay = false
      draft = current
      return
    }
    draft = EventDraft(startMs: startMs, endMs: endMs)
    open(.create)
  }

  func toggle(_ next: IslandView) {
    view == next ? close() : open(next)
  }
}

/// The app's light/dark setting (the web's theme switch): follow the system,
/// or hold one appearance.
enum AppTheme: String, CaseIterable {
  case dark, light, system

  private static let key = "theme"

  static var stored: AppTheme {
    UserDefaults.standard.string(forKey: key).flatMap(AppTheme.init(rawValue:)) ?? .system
  }

  var label: String {
    switch self {
    case .dark: "Dark"
    case .light: "Light"
    case .system: "Device"
    }
  }

  var symbol: String {
    switch self {
    case .dark: "moon"
    case .light: "sun.max"
    case .system: "desktopcomputer"
    }
  }

  /// Applies the appearance to the whole app and remembers it.
  func apply() {
    UserDefaults.standard.set(rawValue, forKey: Self.key)
    switch self {
    case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
    case .light: NSApp.appearance = NSAppearance(named: .aqua)
    case .system: NSApp.appearance = nil
    }
  }
}
