import SwiftUI

/// The Settings window's panes, in sidebar order. The web's settings panel
/// has Accounts, Calendars and Preferences; here Preferences is split into
/// Date & Time and Events, and General holds the account and appearance that
/// the web keeps in the dock's account panel.
enum SettingsPane: String, CaseIterable, Identifiable, Hashable {
  case general, accounts, calendars, dateTime, events, menuBar

  var id: Self { self }

  var title: String {
    switch self {
    case .general: "General"
    case .accounts: "Accounts"
    case .calendars: "Calendars"
    case .dateTime: "Date & Time"
    case .events: "Events"
    case .menuBar: "Menu Bar"
    }
  }

  var symbol: String {
    switch self {
    case .general: "gearshape"
    case .accounts: "person.crop.circle"
    case .calendars: "calendar"
    case .dateTime: "clock"
    case .events: "bell"
    case .menuBar: "menubar.rectangle"
    }
  }
}

/// The selected pane plus a browser-style history for the toolbar's back and
/// forward buttons.
@Observable
final class SettingsNavigation {
  private(set) var pane: SettingsPane = .general
  private var back: [SettingsPane] = []
  private var forward: [SettingsPane] = []

  var canGoBack: Bool { !back.isEmpty }
  var canGoForward: Bool { !forward.isEmpty }

  func show(_ next: SettingsPane) {
    guard next != pane else { return }
    back.append(pane)
    forward.removeAll()
    pane = next
  }

  func goBack() {
    guard let previous = back.popLast() else { return }
    forward.append(pane)
    pane = previous
  }

  func goForward() {
    guard let next = forward.popLast() else { return }
    back.append(pane)
    pane = next
  }
}

struct SettingsView: View {
  @Environment(AppModel.self) private var model
  @Environment(SettingsNavigation.self) private var navigation

  var body: some View {
    NavigationSplitView {
      List(selection: Binding(get: { navigation.pane }, set: { $0.map(navigation.show) })) {
        ForEach(SettingsPane.allCases) { pane in
          Label(pane.title, systemImage: pane.symbol)
            .tag(pane)
        }
      }
      .listStyle(.sidebar)
      .toolbar(removing: .sidebarToggle)
      .navigationSplitViewColumnWidth(min: 190, ideal: 200, max: 240)
    } detail: {
      detail
        .navigationTitle(navigation.pane.title)
        .toolbar {
          ToolbarItemGroup(placement: .navigation) {
            Button("Back", systemImage: "chevron.left", action: navigation.goBack)
              .disabled(!navigation.canGoBack)
              .help("Back")
            Button("Forward", systemImage: "chevron.right", action: navigation.goForward)
              .disabled(!navigation.canGoForward)
              .help("Forward")
          }
        }
    }
    .toolbar(removing: .sidebarToggle)
    .frame(minWidth: 640, minHeight: 420)
  }

  @ViewBuilder private var detail: some View {
    switch navigation.pane {
    case .general:
      GeneralPane()
    case .menuBar:
      MenuBarPane()
    default:
      if let data = model.calendarData {
        switch navigation.pane {
        case .accounts: AccountsPane(data: data)
        case .calendars: CalendarsPane(data: data)
        case .dateTime: DateTimePane(data: data)
        case .events: EventsPane(data: data)
        case .general, .menuBar: EmptyView()
        }
      } else {
        ContentUnavailableView(
          "Not signed in",
          systemImage: "person.crop.circle.badge.questionmark",
          description: Text("Sign in to qali to change this.")
        )
      }
    }
  }
}

// MARK: - Shared pieces

/// Shows a save failure under the form, the way the web toasts one.
struct SaveErrorBanner: ViewModifier {
  @Binding var message: String?

  func body(content: Content) -> some View {
    content.alert(
      message ?? "",
      isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })
    ) {
      Button("OK", role: .cancel) {}
    }
  }
}

extension View {
  func saveErrors(_ message: Binding<String?>) -> some View {
    modifier(SaveErrorBanner(message: message))
  }
}

/// Runs a save and turns a failure into the pane's error message.
@MainActor
func save(_ failure: String, into message: Binding<String?>, _ work: @escaping () async throws -> Void) {
  Task {
    do { try await work() } catch { message.wrappedValue = failure }
  }
}

/// A round photo from a URL with an initial behind it.
struct SettingsAvatar: View {
  let url: String?
  let initial: String
  let size: CGFloat

  var body: some View {
    ZStack {
      Circle().fill(.quaternary)
      Text(initial.uppercased())
        .font(.system(size: size * 0.4, weight: .medium))
        .foregroundStyle(.secondary)
      if let url, let parsed = URL(string: url) {
        RemoteImage(url: parsed)
      }
    }
    .frame(width: size, height: size)
    .clipShape(.circle)
    .accessibilityHidden(true)
  }
}

/// The Google "G", drawn from SF Symbols' globe when no asset exists.
struct ProviderBadge: View {
  let provider: String?
  var size: CGFloat = 14

  var body: some View {
    Text(provider == "microsoft" ? "O" : "G")
      .font(.system(size: size * 0.62, weight: .bold, design: .rounded))
      .foregroundStyle(provider == "microsoft" ? Color.blue : Color.primary)
      .frame(width: size, height: size)
      .background(Circle().fill(.background))
      .overlay(Circle().strokeBorder(.separator, lineWidth: 0.5))
  }
}
