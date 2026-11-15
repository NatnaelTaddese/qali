import QaliDomain
import SwiftUI

/// The signed-in window: the web app's calendar header as a native toolbar,
/// over the calendar grid.
struct CalendarScreen: View {
  let data: CalendarData
  @State private var navigation = CalendarNavigation()

  var body: some View {
    CalendarGrid(navigation: navigation, data: data)
      .toolbar { CalendarToolbar(navigation: navigation, data: data) }
      .background { shortcuts }
      .onChange(of: data.preferences, initial: true) { _, preferences in
        if let preferences { navigation.apply(preferences) }
      }
      .onChange(of: navigation.eventRange, initial: true) { _, range in
        data.setEventWindow(startMs: range.lowerBound, endMs: range.upperBound)
      }
  }

  /// The web's single-key shortcuts. They have no visible control of their
  /// own (the view switch is one segmented control), so they hang off hidden
  /// buttons.
  private var shortcuts: some View {
    Group {
      Button("Day view") { navigation.show(.day) }.keyboardShortcut("d", modifiers: [])
      Button("Week view") { navigation.show(.week) }.keyboardShortcut("w", modifiers: [])
      Button("Month view") { navigation.show(.month) }.keyboardShortcut("m", modifiers: [])
      Button("Previous") { navigation.step(-1) }.keyboardShortcut(.leftArrow, modifiers: [])
      Button("Next") { navigation.step(1) }.keyboardShortcut(.rightArrow, modifiers: [])
    }
    .opacity(0)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// The web calendar header (`<header>` in components/calendar/calendar.tsx),
/// item for item: the title with its week chip and month picker on the
/// leading side; the view switch, Today and the arrows, the calendar picker
/// and the notification bell on the trailing side. Each trailing cluster is
/// its own glass capsule, and the dropdowns are system popovers.
struct CalendarToolbar: ToolbarContent {
  let navigation: CalendarNavigation
  let data: CalendarData

  var body: some ToolbarContent {
    ToolbarItem(placement: .navigation) {
      MonthPickerButton(navigation: navigation)
    }
    // A title, not a control: no capsule behind it.
    .sharedBackgroundVisibility(.hidden)

    // Everything else sits against the trailing edge, as on the web.
    ToolbarSpacer(.flexible)

    ToolbarItem(placement: .primaryAction) {
      Picker("View", selection: Binding(get: { navigation.view }, set: navigation.show)) {
        ForEach(CalendarView.allCases, id: \.self) { view in
          Text(view.rawValue.capitalized).tag(view)
        }
      }
      .pickerStyle(.segmented)
      .help("Switch between day, week and month (D, W, M)")
    }

    ToolbarSpacer(.fixed, placement: .primaryAction)

    ToolbarItemGroup(placement: .primaryAction) {
      Button("Today") { navigation.goToToday() }
        .keyboardShortcut("t", modifiers: [])
        .help("Go to today (T)")
      Button("Previous", systemImage: "chevron.left") { navigation.step(-1) }
        .help("Previous \(navigation.view.rawValue)")
      Button("Next", systemImage: "chevron.right") { navigation.step(1) }
        .help("Next \(navigation.view.rawValue)")
    }

    ToolbarSpacer(.fixed, placement: .primaryAction)

    ToolbarItem(placement: .primaryAction) {
      CalendarsButton(data: data)
    }

    ToolbarSpacer(.fixed, placement: .primaryAction)

    ToolbarItem(placement: .primaryAction) {
      NotificationsButton(data: data, navigation: navigation)
    }
  }
}
