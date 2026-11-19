import QaliDomain
import SwiftUI

/// The signed-in window: the web app's calendar header as a native toolbar,
/// over the calendar grid, with the bottom island floating at its foot.
struct CalendarScreen: View {
  let data: CalendarData
  @State private var navigation = CalendarNavigation()
  @State private var island = Island()

  var body: some View {
    CalendarGrid(navigation: navigation, data: data)
      .overlay(alignment: .bottom) {
        BottomIsland(island: island, data: data, navigation: navigation)
      }
      // For the event cards, which open themselves in the island.
      .environment(island)
      .toolbar {
        // The update status is read here, in a view's body, so the toolbar is
        // rebuilt when it changes.
        CalendarToolbar(
          navigation: navigation, data: data, island: island, typing: island.isTyping,
          update: AppUpdater.shared.status)
      }
      .background { shortcuts }
      .onChange(of: data.preferences, initial: true) { _, preferences in
        if let preferences { navigation.apply(preferences) }
      }
      .onChange(of: navigation.eventRange, initial: true) { _, range in
        data.setEventWindow(startMs: range.lowerBound, endMs: range.upperBound)
      }
      #if DEBUG
        // `-QaliCycle month,week,day,week` steps through views after launch,
        // so their transitions can be watched without touching the toolbar.
        .task {
          guard let script = UserDefaults.standard.string(forKey: "QaliCycle") else { return }
          try? await Task.sleep(for: .seconds(3))
          for view in script.split(separator: ",").compactMap({ CalendarView(rawValue: String($0)) }) {
            navigation.showAnimated(view)
            try? await Task.sleep(for: .seconds(1.5 * max(UserDefaults.standard.double(forKey: "QaliSlow"), 1)))
          }
        }
      #endif
  }

  /// The web's single-key shortcuts. They have no visible control of their
  /// own (the view switch is one segmented control), so they hang off hidden
  /// buttons.
  private var shortcuts: some View {
    Group {
      Button("Day view") { navigation.showAnimated(.day) }.keyboardShortcut("d", modifiers: [])
      Button("Week view") { navigation.showAnimated(.week) }.keyboardShortcut("w", modifiers: [])
      Button("Month view") { navigation.showAnimated(.month) }.keyboardShortcut("m", modifiers: [])
      Button("Previous") { navigation.step(-1) }.keyboardShortcut(.leftArrow, modifiers: [])
      Button("Next") { navigation.step(1) }.keyboardShortcut(.rightArrow, modifiers: [])
    }
    // Bare keys are text while a panel with a field is up.
    .disabled(island.isTyping)
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
  /// Handed to the bell, whose reminders open their event in it.
  let island: Island
  /// A field in the island has the keyboard: T is a letter, not Today.
  var typing = false
  /// Shown as a pill before the view switch unless idle.
  var update: UpdateStatus = .idle

  var body: some ToolbarContent {
    ToolbarItem(placement: .navigation) {
      MonthPickerButton(navigation: navigation)
    }
    // A title, not a control: no capsule behind it.
    .sharedBackgroundVisibility(.hidden)

    // Everything else sits against the trailing edge, as on the web.
    ToolbarSpacer(.flexible)

    if update != .idle {
      ToolbarItem(placement: .primaryAction) {
        UpdatePill(status: update)
      }

      ToolbarSpacer(.fixed, placement: .primaryAction)
    }

    ToolbarItem(placement: .primaryAction) {
      Picker("View", selection: Binding(get: { navigation.view }, set: navigation.showAnimated)) {
        ForEach(CalendarView.allCases, id: \.self) { view in
          Text(view.rawValue.capitalized).tag(view)
        }
      }
      .pickerStyle(.segmented)
      .help("Switch between day, week and month (D, W, M)")
    }

    ToolbarSpacer(.fixed, placement: .primaryAction)

    // Today and the arrows share one capsule: a single item, since separate
    // items each get their own. Their hover is drawn by `ToolbarPillButtonStyle`
    // to match the view switch beside them.
    ToolbarItem(placement: .primaryAction) {
      HStack(spacing: 2) {
        Button("Today") { navigation.goToToday() }
          .keyboardShortcut(typing ? nil : KeyboardShortcut("t", modifiers: []))
          .help("Go to today (T)")
        // The month scrolls up and down, so there the arrows turn to say so.
        let turn = Angle.degrees(navigation.view == .month ? 90 : 0)
        Button { navigation.step(-1) } label: {
          Label("Previous", systemImage: "chevron.left").rotationEffect(turn)
        }
        .help(stepHelp(back: true))
        Button { navigation.step(1) } label: {
          Label("Next", systemImage: "chevron.right").rotationEffect(turn)
        }
        .help(stepHelp(back: false))
      }
      // The capsule's own inset around its pills, as in the view switch.
      .padding(.horizontal, 4)
      .buttonStyle(ToolbarPillButtonStyle())
      .labelStyle(.iconOnly)
      .animation(.snappy(duration: 0.3), value: navigation.view == .month)
    }

    ToolbarSpacer(.fixed, placement: .primaryAction)

    ToolbarItem(placement: .primaryAction) {
      CalendarsButton(data: data)
    }

    ToolbarSpacer(.fixed, placement: .primaryAction)

    ToolbarItem(placement: .primaryAction) {
      NotificationsButton(data: data, navigation: navigation, island: island)
    }
  }

  private func stepHelp(back: Bool) -> String {
    if navigation.view == .month { return back ? "Previous month (←)" : "Next month (→)" }
    let days = navigation.stepDays == 1 ? "1 day" : "\(navigation.stepDays) days"
    return back ? "Back \(days) (←)" : "Forward \(days) (→)"
  }
}

extension CalendarNavigation {
  /// Changes the view with the grid's switch animation. Every switch is the
  /// same kind of move, a change of geometry: Day to Week widens the day's
  /// column into seven, and Week to Month squeezes the week into its row of
  /// the month (see `CalendarGrid`).
  func showAnimated(_ view: CalendarView) {
    // Day and Week are one grid at two widths: a quick snap. To and from
    // Month is a zoom, which wants a slower, even glide.
    guard view != self.view else { return }
    guard view == .month || self.view == .month else {
      return withAnimation(.snappy(duration: Self.scaled(0.35))) { show(view) }
    }
    zoomAnimated { show(view) }
  }

  /// Zooms the month into `day`, with the same animation as a view switch.
  func openAnimated(day: Date) {
    zoomAnimated { open(day: day) }
  }

  /// Runs a change to or from the month as a zoom, flagging `zooming` until
  /// it has landed.
  private func zoomAnimated(_ change: () -> Void) {
    zoomToken += 1
    let token = zoomToken
    zooming = true
    withAnimation(Self.zoomAnimation, completionCriteria: .removed) {
      change()
    } completion: { [weak self] in
      guard let self, self.zoomToken == token else { return }
      self.zooming = false
    }
  }

  /// The month zoom's length.
  static var zoomDuration: Double { scaled(0.5) }

  /// The month zoom: a critically damped spring, so it eases in and settles
  /// without the front-loaded rush of `.snappy`.
  static var zoomAnimation: Animation { .spring(duration: zoomDuration, bounce: 0) }

  /// `-QaliSlow 8` stretches the switches out, to study them frame by frame.
  static func scaled(_ seconds: Double) -> Double {
    #if DEBUG
      return seconds * max(UserDefaults.standard.double(forKey: "QaliSlow"), 1)
    #else
      return seconds
    #endif
  }
}

/// A toolbar button whose hover is the segmented control's pill: a soft fill
/// inset evenly from the glass capsule, in place of the toolbar's own
/// brighter, full-height highlight, so a group of buttons reads like the
/// view switch next to it.
struct ToolbarPillButtonStyle: ButtonStyle {
  /// Rests on the pill's fill, like the view switch's selected segment: for
  /// the one action in a group that should stand out (the update pill's
  /// Update / Relaunch Now).
  var selected = false

  func makeBody(configuration: Configuration) -> some View {
    Pill(configuration: configuration, selected: selected)
  }

  private struct Pill: View {
    let configuration: Configuration
    let selected: Bool
    @State private var hovering = false
    /// Toolbar controls grey out while the window is in the background.
    @Environment(\.appearsActive) private var appearsActive

    var body: some View {
      let fill =
        configuration.isPressed ? 0.14
        : selected ? (hovering ? 0.13 : 0.09)
        : hovering || Self.debugHover ? 0.09 : 0
      configuration.label
        .font(.system(size: 13, weight: .medium))
        .imageScale(.large)
        .foregroundStyle(appearsActive ? .primary : .secondary)
        .padding(.horizontal, 10)
        .frame(minWidth: 28, minHeight: 28)
        .background { Capsule().fill(.primary.opacity(fill)) }
        .contentShape(Capsule())
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }

    #if DEBUG
      /// `-QaliPillHover YES` shows every pill as hovered, to capture the look
      /// without a pointer.
      static let debugHover = UserDefaults.standard.bool(forKey: "QaliPillHover")
    #else
      static let debugHover = false
    #endif
  }
}
