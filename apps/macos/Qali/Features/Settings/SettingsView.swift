import AppKit
import SwiftUI

/// The Settings window's panes, in sidebar order. The web's settings panel
/// has Accounts, Calendars and Preferences; here Preferences is split into
/// Date & Time and Events, and General holds the account and appearance that
/// the web keeps in the dock's account panel.
enum SettingsPane: String, CaseIterable, Identifiable, Hashable {
  case general, accounts, calendars, dateTime, events, booking, menuBar

  var id: Self { self }

  var title: String {
    switch self {
    case .general: "General"
    case .accounts: "Accounts"
    case .calendars: "Calendars"
    case .dateTime: "Date & Time"
    case .events: "Events"
    case .booking: "Booking Link"
    case .menuBar: "Menu Bar"
    }
  }

  /// The white glyph on the pane's tile.
  var symbol: String {
    switch self {
    case .general: "gearshape.fill"
    case .accounts: "person.fill"
    case .calendars: "calendar"
    case .dateTime: "clock.fill"
    case .events: "bell.fill"
    case .booking: "link"
    case .menuBar: "menubar.rectangle"
    }
  }

  /// The tile's colour, as System Settings colours its panes: grey for the
  /// general pane, the calendar's red, and no two neighbours alike.
  var tint: Color {
    switch self {
    case .general: .gray
    case .accounts: .blue
    case .calendars: .red
    case .dateTime: .indigo
    case .events: .orange
    case .booking: .green
    case .menuBar: Color(white: 0.32)
    }
  }
}

/// A pane's sidebar icon: its glyph in white on a rounded tile of the pane's
/// colour, lit from above, like the system's own settings sidebars.
struct SettingsPaneIcon: View {
  let pane: SettingsPane

  var body: some View {
    let tile = RoundedRectangle(cornerRadius: 5.5, style: .continuous)
    Image(systemName: pane.symbol)
      .font(.system(size: 11.5, weight: .semibold))
      .foregroundStyle(.white)
      .shadow(color: .black.opacity(0.15), radius: 0.5, y: 0.5)
      .frame(width: 22, height: 22)
      .background(pane.tint.gradient, in: tile)
      // A hairline of light on the rim, as on the system's tiles.
      .overlay(tile.strokeBorder(.white.opacity(0.18), lineWidth: 0.5))
      .shadow(color: .black.opacity(0.12), radius: 0.5, y: 0.5)
      .accessibilityHidden(true)
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
          // Each pane on its own coloured tile and the selected pane in
          // semibold, like the system's own settings sidebars. A plain row,
          // since a sidebar tints and fills a Label's icon.
          HStack(spacing: 8) {
            SettingsPaneIcon(pane: pane)
            Text(pane.title)
              .fontWeight(navigation.pane == pane ? .semibold : .regular)
              // Centred on its capitals, not its line box: room for
              // descenders otherwise lifts the letters about a point.
              .alignmentGuide(VerticalAlignment.center) { d in
                d[.firstTextBaseline] - NSFont.systemFont(ofSize: NSFont.systemFontSize).capHeight / 2
              }
          }
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
        case .booking: BookingPane(data: data)
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
