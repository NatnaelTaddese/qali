import QaliDomain
import SwiftUI

/// The signed-in window: the web app's calendar header as a native toolbar,
/// over the calendar grid, with the bottom island floating at its foot.
struct CalendarScreen: View {
  let data: CalendarData
  @Environment(AppModel.self) private var model
  @State private var navigation = CalendarNavigation()
  @State private var island = Island()
  /// The update's notes, once the calendar has settled in.
  @State private var whatsNew: ReleaseNotes?

  var body: some View {
    CalendarGrid(navigation: navigation, data: data)
      .overlay(alignment: .bottom) {
        BottomIsland(island: island, data: data, navigation: navigation)
      }
      // The assistant, a Messages conversation floating over the calendar's
      // trailing edge. It slides over the grid rather than docking beside it:
      // resizing the grid on every frame of the slide made it judder.
      .overlay(alignment: .trailing) {
        if assistantOpen.wrappedValue {
          AssistantPanel(data: data, navigation: navigation) { assistantOpen.wrappedValue = false }
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
      }
      // Its toggle: Qali's ghost in the bottom-right corner, where the web's
      // assistant dock sits, level with the island.
      .overlay(alignment: .bottomTrailing) {
        if data.assistant.isAvailable {
          AssistantCornerButton(isOpen: assistantOpen, unread: data.assistant.unread)
            .padding(.trailing, AssistantPanel.cornerInset)
            .padding(.bottom, AssistantPanel.cornerInset)
        }
      }
      .animation(AssistantPanel.spring, value: assistantOpen.wrappedValue)
      // Notifications that land while this window is in front.
      .overlay(alignment: .topTrailing) {
        NotificationToasts(notifier: model.notifier) { row in
          openNotification(row, data: data, island: island, navigation: navigation)
        }
      }
      // One clicked in Notification Center, once the window is forward.
      .onChange(of: model.notifier.pendingOpen, initial: true) { _, row in
        guard let row else { return }
        model.notifier.pendingOpen = nil
        openNotification(row, data: data, island: island, navigation: navigation)
      }
      // For the event cards, which open themselves in the island.
      .environment(island)
      .toolbar {
        // The update status is read here, in a view's body, so the toolbar is
        // rebuilt when it changes.
        CalendarToolbar(
          navigation: navigation, data: data, island: island, typing: typing,
          update: AppUpdater.shared.status)
      }
      .background { shortcuts }
      .onChange(of: data.preferences, initial: true) { _, preferences in
        if let preferences { navigation.apply(preferences) }
      }
      .onChange(of: navigation.eventRange, initial: true) { _, range in
        data.setEventWindow(startMs: range.lowerBound, endMs: range.upperBound)
      }
      // Days are painted on the time grid, so painting leaves the month.
      .onChange(of: data.booking.isPainting) { _, painting in
        if painting, navigation.view == .month { navigation.showAnimated(.week) }
      }
      // The grid's date keys are cut in the working zone, which the page was
      // saved in; a change elsewhere mid-paint ends it, as on the web.
      .onChange(of: data.preferences?.zone.identifier) { _, _ in
        guard data.booking.isPainting, case .some(.some(let page)) = data.booking.page,
          page.timeZone != navigation.zone.identifier
        else { return }
        data.booking.stopPainting()
        data.announce("Availability editing closed: your working time zone changed. Open it again to carry on in the new zone.")
      }
      // After an update: the new version's notes, once, a moment after the
      // calendar is up rather than over the loader.
      .task {
        guard let notes = model.whatsNew else { return }
        try? await Task.sleep(for: .seconds(0.8))
        whatsNew = notes
      }
      .sheet(item: $whatsNew, onDismiss: {
        if let notes = model.whatsNew { WhatsNew.markSeen(notes) }
        model.whatsNew = nil
      }) { notes in
        WhatsNewSheet(notes: notes) { whatsNew = nil }
      }
      #if DEBUG
        // `-QaliAssistantToggle 3` opens or closes the assistant that many
        // seconds after launch, to watch it slide.
        .task {
          let delay = UserDefaults.standard.double(forKey: "QaliAssistantToggle")
          guard delay > 0 else { return }
          try? await Task.sleep(for: .seconds(delay))
          model.assistantOpen.toggle()
        }
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

  /// Out beside the calendar, once this deployment has an assistant.
  private var assistantOpen: Binding<Bool> {
    Binding(
      get: { model.assistantOpen && data.assistant.isAvailable },
      set: { model.assistantOpen = $0 }
    )
  }

  /// A field has the keyboard: bare keys are text, not shortcuts.
  private var typing: Bool { island.isTyping || data.assistant.composerFocused }

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
    .disabled(typing)
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

