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

extension SettingsPane {
  /// The settings this pane holds, by the names its rows show, for the
  /// sidebar's search. Keep in step with the panes.
  var settings: [String] {
    switch self {
    case .general:
      ["Account", "Sign Out", "Theme", "Default view", "Check for updates automatically",
       "Download and install updates automatically", "Version"]
    case .accounts: ["Google account", "Another account", "Calendar access", "Contacts access", "Sync", "Disconnect"]
    case .calendars: ["Show or hide calendars", "Rename calendars"]
    case .dateTime:
      ["Time zone", "Week starts on", "Time format", "Other time zones", "Show times under the pointer"]
    case .events: ["Default calendar", "Timed event reminders", "All-day event reminders"]
    case .booking:
      ["Link name", "Share", "Live", "Title", "Length", "Minimum notice", "Days ahead",
       "Ignore all-day events", "Weekly hours", "Change single days"]
    case .menuBar:
      ["Show qali in the menu bar", "Show the next event", "Show event titles", "Show Join before calls",
       "Include tomorrow", "World clock", "Show day and night icons", "Show day and offset",
       "Include your time zone", "Open at login", "Hide the Dock icon when the window is closed"]
    }
  }

  /// Other words people may search by, each with the setting it finds
  /// (nil for the pane as a whole).
  private var keywords: [String: String?] {
    switch self {
    case .general:
      ["appearance": "Theme", "dark": "Theme", "light": "Theme", "mode": "Theme",
       "log out": "Sign Out", "update": "Check for updates automatically",
       "day": "Default view", "week": "Default view", "month": "Default view"]
    case .accounts:
      ["google": "Google account", "connect": "Another account", "link": "Another account",
       "permissions": "Calendar access", "unlink": "Disconnect", "remove": "Disconnect"]
    case .calendars:
      ["colour": nil, "color": nil, "visible": "Show or hide calendars", "name": "Rename calendars"]
    case .dateTime:
      ["timezone": "Time zone", "clock": "Time format", "24-hour": "Time format", "12-hour": "Time format",
       "am": "Time format", "pm": "Time format", "monday": "Week starts on", "sunday": "Week starts on"]
    case .events:
      ["reminder": "Timed event reminders", "notification": "Timed event reminders",
       "alert": "Timed event reminders", "new event": "Default calendar"]
    case .booking:
      ["availability": "Weekly hours", "schedule": "Weekly hours", "slots": "Length", "booking page": nil,
       "appointments": nil, "url": "Link name", "holiday": "Ignore all-day events"]
    case .menuBar:
      ["status bar": nil, "menubar": nil, "dock": "Hide the Dock icon when the window is closed",
       "login": "Open at login", "startup": "Open at login", "join": "Show Join before calls",
       "video": "Show Join before calls", "countdown": "Show event titles", "agenda": "Show the next event"]
    }
  }

  /// What a search finds here: nil when nothing does, else the settings it
  /// names (empty when only the pane itself matched).
  func matches(_ query: String) -> [String]? {
    let query = query.trimmingCharacters(in: .whitespaces)
    guard !query.isEmpty else { return [] }
    var found = settings.filter { $0.localizedStandardContains(query) }
    let words = keywords.filter { $0.key.localizedStandardContains(query) }
    for case let setting? in words.values where !found.contains(setting) { found.append(setting) }
    if !found.isEmpty { return found }
    if title.localizedStandardContains(query) || !words.isEmpty { return [] }
    return nil
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

  /// The sidebar's search, which narrows the panes to those holding a
  /// matching setting, as System Settings' does.
  @State private var query: String = {
    #if DEBUG
      // `-QaliSettingsSearch zone` opens with that search typed, for captures.
      UserDefaults.standard.string(forKey: "QaliSettingsSearch") ?? ""
    #else
      ""
    #endif
  }()

  var body: some View {
    let results = SettingsPane.allCases.compactMap { pane in pane.matches(query).map { (pane, $0) } }
    NavigationSplitView {
      List(selection: Binding(get: { navigation.pane }, set: { $0.map(navigation.show) })) {
        ForEach(results, id: \.0) { pane, found in
          // Each pane on its own coloured tile and the selected pane in
          // semibold, like the system's own settings sidebars. A plain row,
          // since a sidebar tints and fills a Label's icon.
          HStack(spacing: 8) {
            SettingsPaneIcon(pane: pane)
            VStack(alignment: .leading, spacing: 1) {
              Text(pane.title)
                .fontWeight(navigation.pane == pane ? .semibold : .regular)
              // While searching, the settings that matched, under the pane
              // that holds them.
              if !found.isEmpty {
                Text(found.prefix(3).joined(separator: ", "))
                  .font(.caption)
                  .foregroundStyle(.secondary)
                  .lineLimit(2)
              }
            }
            // Centred on its capitals, not its line box: room for
            // descenders otherwise lifts the letters about a point.
            .alignmentGuide(VerticalAlignment.center) { d in
              found.isEmpty
                ? d[.firstTextBaseline] - NSFont.systemFont(ofSize: NSFont.systemFontSize).capHeight / 2
                : d[VerticalAlignment.center]
            }
          }
          .tag(pane)
        }
      }
      .listStyle(.sidebar)
      // A quiet line, as System Settings shows; the full empty state is too
      // big for the sidebar.
      .overlay(alignment: .top) {
        if results.isEmpty {
          Text("No Results")
            .font(.callout)
            .foregroundStyle(.secondary)
            .padding(.top, 24)
        }
      }
      .searchable(text: $query, placement: .sidebar, prompt: "Search")
      // Return opens the first result.
      .onSubmit(of: .search) {
        if let first = results.first?.0 { navigation.show(first) }
      }
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

/// A form row with a title over a detail line and its control centred on
/// the pair. Grouped forms pin a control to a two-line label's first line,
/// which reads as sitting high, so every two-line row in Settings uses this.
struct SettingsRow<Title: View, Detail: View, Control: View>: View {
  @ViewBuilder var title: Title
  @ViewBuilder var detail: Detail
  @ViewBuilder var control: Control

  /// A disabled row dims its words, as the form does its own labels.
  @Environment(\.isEnabled) private var isEnabled

  init(
    @ViewBuilder control: () -> Control,
    @ViewBuilder title: () -> Title,
    @ViewBuilder detail: () -> Detail
  ) {
    self.title = title()
    self.detail = detail()
    self.control = control()
  }

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        title
          .foregroundStyle(isEnabled ? .primary : .tertiary)
        detail
          .font(.subheadline)
          .foregroundStyle(isEnabled ? .secondary : .tertiary)
      }
      Spacer(minLength: 8)
      control
    }
  }
}

extension SettingsRow where Title == Text, Detail == Text {
  init(_ title: String, detail: String, @ViewBuilder control: () -> Control) {
    self.init(control: control) { Text(title) } detail: { Text(detail) }
  }
}

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
