import ConvexMobile
import QaliDomain
import SwiftUI

/// The island's create and edit faces (the web's `EventCreate` and
/// `EventEdit` over `EventForm`), in the web's order: privacy, title and
/// description; when it starts and ends; all day, reminders, repeat, where and
/// guests; then the calendar, colour and free/busy beside Cancel and Create or
/// Save. The controls are the stock macOS ones.
///
/// The draft lives on the island, so the ghost on the grid follows the times
/// while they are edited here. Editing starts from the event's own values and
/// saves only what changed; a repeating event asks how far the change reaches.
struct EventFormPanel: View {
  enum Mode {
    case create
    case edit(CalendarEvent)
  }

  @Binding var draft: EventDraft
  let mode: Mode
  let island: Island
  let data: CalendarData
  let navigation: CalendarNavigation

  @State private var submitting = false
  /// The idempotency key for this create or save, minted on the first try
  /// and kept across retries so the backend acts once, not twice.
  @State private var operationId: String?
  /// The form as it opened: what an edit's save is diffed against. Taken
  /// once, so a sync landing mid-edit can't erase what is being typed.
  @State private var initial: EventDraft
  @State private var guestText = ""
  @FocusState private var titleFocused: Bool
  /// Which screen fills the panel: the form, or the description editor.
  @State private var editingNotes = false
  /// The description as edited, kept while the form is up so returning to
  /// the editor finds it as it was left.
  @State private var notesText = NSAttributedString()
  /// The form's height, which the description screen keeps so the island
  /// stays put while only its contents change.
  @State private var formHeight: CGFloat?
  /// The Where switch's thumb, which slides between its two segments.
  @Namespace private var whereThumb
  /// A repeating event's series rule lines (the inner nil is "not fetched
  /// yet"); nothing is asked for a single event or a new one.
  @State private var seriesRule: LiveQuery<[String]?>
  /// Set once the series' rule is read into `initial` and `draft`: from then
  /// on its repeat can be changed.
  @State private var seriesRuleLoaded = false

  init(draft: Binding<EventDraft>, mode: Mode = .create, island: Island, data: CalendarData, navigation: CalendarNavigation) {
    _draft = draft
    self.mode = mode
    _initial = State(initialValue: draft.wrappedValue)
    var seriesEvent: CalendarEvent?
    if case .edit(let event) = mode, event.providerSeriesId != nil { seriesEvent = event }
    _seriesRule = State(
      initialValue: LiveQuery(
        data.client,
        ConvexAPI.getEventRecurrence,
        args: seriesEvent.map { ["eventId": $0.id] }
      )
    )
    self.island = island
    self.data = data
    self.navigation = navigation
    // An edited event arrives with its description: the editor starts there.
    _notesText = State(initialValue: draft.wrappedValue.notesHTML.map(DescriptionHTML.attributed(from:)) ?? NSAttributedString())
    #if DEBUG
      // `-QaliGuestQuery an` opens the form with that typed in the guest
      // search, to look at the matches without typing.
      _guestText = State(initialValue: UserDefaults.standard.string(forKey: "QaliGuestQuery") ?? "")
    #endif
  }

  private var zone: WorkingZone { navigation.zone }

  /// The event being edited, as the live window has it now.
  private var editing: CalendarEvent? {
    if case .edit(let event) = mode { data.current(event) } else { nil }
  }

  /// What the user may change. A new event is all theirs.
  private var capabilities: EventCapabilities? { editing.map(data.capabilities(for:)) }

  private var isRecurring: Bool { editing?.providerSeriesId != nil }

  private var titlePlaceholder: String { editing == nil ? "New event" : "(No title)" }

  /// The calendar the event goes to: the one picked, else the default.
  private var calendar: CalendarListItem? {
    draft.calendarId.flatMap(data.calendar(id:)) ?? data.defaultCalendar
  }

  var body: some View {
    ZStack(alignment: .topLeading) {
      if editingNotes {
        DescriptionPage(
          title: draft.summary.trimmingCharacters(in: .whitespaces).isEmpty ? titlePlaceholder : draft.summary,
          initial: notesText,
          back: { showNotes(false) }
        ) { text in
          notesText = text
          draft.notesHTML = DescriptionHTML.html(from: text)
          draft.notesPreview = DescriptionHTML.preview(from: text)
        }
        .frame(height: formHeight)
        .transition(.drillDown(forward: true))
      } else {
        form
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { formHeight = $0 }
          .transition(.drillDown(forward: false))
      }
    }
    .font(.sans(TextSize.sm))
    .foregroundStyle(Palette.foreground)
    .disabled(submitting)
    #if DEBUG
      // `-QaliDescription demo` opens the description screen and writes a
      // short formatted description into it, as typing and the toolbar would.
      .task {
        guard UserDefaults.standard.string(forKey: "QaliDescription") == "demo" else { return }
        try? await Task.sleep(for: .seconds(1))
        showNotes(true)
      }
    #endif
  }

  private func showNotes(_ show: Bool) {
    withAnimation(Island.spring) { editingNotes = show }
  }

  private var form: some View {
    VStack(alignment: .leading, spacing: 12) {
      if editing != nil {
        HStack {
          BackButton(title: "Edit event", action: island.cancel)
          Spacer(minLength: 0)
        }
        .padding(.bottom, -4)
      }
      header
      times
      VStack(alignment: .leading, spacing: 8) {
        SettingRow(symbol: "sun.max", label: "All day") {
          Toggle("All day", isOn: $draft.allDay.animation(Island.spring))
            .toggleStyle(.switch)
            .controlSize(.small)
            .labelsHidden()
        }
        SettingRow(symbol: "bell", label: "Reminder") { reminderMenu }
        SettingRow(symbol: "repeat", label: "Repeat") { repeatMenu }
        whereRow
        guestsRow
      }

      if !draft.isValid {
        Text("End time must be after the start.")
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.destructive)
      }

      footer
    }
    .task(id: seriesRule.value) { await readSeriesRule() }
    .task {
      // An edit opens on what is there; only a new event starts typing.
      guard editing == nil else { return }
      // Let the face land before taking focus, or the field is still being
      // inserted and the focus is dropped.
      try? await Task.sleep(for: .milliseconds(50))
      titleFocused = true
    }
  }

  // MARK: Title

  private var header: some View {
    HStack(alignment: .top, spacing: 10) {
      Button {
        draft.isPrivate.toggle()
      } label: {
        Image(systemName: draft.isPrivate ? "lock" : "lock.open")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(draft.isPrivate ? Palette.foreground : Palette.mutedForeground)
          .frame(width: 28, height: 28)
          .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(Palette.foreground.opacity(draft.isPrivate ? 0.1 : 0))
          }
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .help(draft.isPrivate ? "Private" : "Visible to others")
      .accessibilityLabel(draft.isPrivate ? "Private" : "Visible to others")

      VStack(alignment: .leading, spacing: 4) {
        TextField(titlePlaceholder, text: $draft.summary)
          .textFieldStyle(.plain)
          .font(.sans(TextSize.base, .semibold))
          .focused($titleFocused)
          .onSubmit(submit)
        DescriptionLink(preview: draft.notesPreview) { showNotes(true) }
      }
      .padding(.top, 5)

      if editing == nil {
        IslandCloseButton(action: island.close)
      }
    }
  }

  // MARK: When

  private var times: some View {
    VStack(spacing: 6) {
      TimeRow(
        label: "Starts",
        ms: draft.startMs,
        allDay: draft.allDay,
        minDay: nil,
        navigation: navigation,
        set: setStart
      )
      TimeRow(
        label: "Ends",
        ms: draft.endMs,
        allDay: draft.allDay,
        minDay: zone.startOfDay(Date(ms: draft.startMs)),
        navigation: navigation,
        set: { draft.endMs = $0 }
      )
    }
    .padding(10)
    .background(Palette.foreground.opacity(0.06), in: .rect(cornerRadius: 12, style: .continuous))
  }

  /// A later or earlier start carries the end along, so the event keeps its
  /// length.
  private func setStart(_ ms: Double) {
    let length = max(draft.endMs - draft.startMs, snapMs)
    // A weekly rule on the start's own day follows the start to its new day.
    // Not a series' rule: moving one occurrence doesn't change the series.
    let oldDay = Recurrence.Weekday.of(draft.startMs, zone: zone)
    if !isRecurring, var rule = draft.repeatRule, rule.freq == .weekly, rule.byWeekday == [oldDay] {
      rule.byWeekday = [Recurrence.Weekday.of(ms, zone: zone)]
      draft.repeatRule = rule
    }
    draft.startMs = ms
    draft.endMs = ms + length
  }

  // MARK: Settings

  private var reminderMenu: some View {
    let allDay = draft.allDay
    let use24h = navigation.use24h
    let chosen = draft.reminders ?? []
    return Menu {
      Toggle("Default", isOn: Binding(get: { draft.reminders == nil }, set: { if $0 { draft.reminders = nil } }))
      Toggle("None", isOn: Binding(get: { draft.reminders == [] }, set: { if $0 { draft.reminders = [] } }))
      Divider()
      ForEach(ReminderPresets.presets(allDay: allDay), id: \.self) { minutes in
        Toggle(
          ReminderPresets.label(minutes, allDay: allDay, use24h: use24h),
          isOn: Binding(
            get: { chosen.contains(minutes) },
            set: { on in
              var next = draft.reminders ?? []
              if on {
                // Providers keep five at most.
                guard next.count < 5 else { return }
                next.append(minutes)
              } else {
                next.removeAll { $0 == minutes }
              }
              draft.reminders = next.sorted()
            }
          )
        )
      }
    } label: {
      MenuLabel(
        ReminderPresets.summary(
          draft.reminders,
          allDay: allDay,
          use24h: use24h,
          defaults: data.defaultReminders(allDay: allDay)
        )
      )
    }
    .modifier(SettingMenuStyle())
  }

  @ViewBuilder private var repeatMenu: some View {
    // A series' repeat is edited once its rule is read and is one the picker
    // can show; until then, or for a rule it can't, it is described.
    if let capabilities, !capabilities.canChangeRecurrence || (isRecurring && !seriesRuleLoaded) {
      Text(isRecurring ? seriesText : "Does not repeat")
        .font(.sans(TextSize.sm, .medium))
        .foregroundStyle(Palette.mutedForeground)
        .lineLimit(1)
    } else {
      repeatPicker
    }
  }

  /// The series' rule in words when a panel has read it, else a plain note.
  private var seriesText: String {
    guard let event = editing else { return "Part of a repeating series" }
    return data.recurrenceSummary(series: event.providerSeriesId ?? event.id, zone: zone) ?? "Part of a repeating series"
  }

  /// Takes in the series' rule once it arrives, as the baseline and the
  /// shown value; asks the server to fetch it when it holds none yet.
  private func readSeriesRule() async {
    guard let event = editing, isRecurring, !seriesRuleLoaded else { return }
    switch seriesRule.value {
    case .some(.some(let lines)):
      guard let rule = Recurrence.parse(lines, zone: zone) else { return }
      initial.repeatRule = rule
      draft.repeatRule = rule
      seriesRuleLoaded = true
    case .some(.none):
      try? await data.refreshRecurrence(of: event)
    case .none:
      return
    }
  }

  /// How far a save may reach. A new repeat can't apply to one occurrence,
  /// and stopping a series ends it from this occurrence on.
  private var saveScopes: [EditScope] {
    guard let event = editing else { return [] }
    let patch = EventPatch(from: initial, to: draft, event: event, zone: zone)
    guard let rule = patch.recurrence else { return EditScope.allCases }
    return rule.isEmpty ? [.thisAndFollowing] : [.thisAndFollowing, .allEvents]
  }

  private var repeatPicker: some View {
    RepeatField(rule: $draft.repeatRule, startMs: draft.startMs, navigation: navigation)
  }

  /// A place or a video call: one row whose switch swaps the location field
  /// for the Google Meet chip.
  private var whereRow: some View {
    HStack(spacing: 10) {
      Group {
        if draft.meet {
          // The web's GoogleMeetIcon: the 2026 Meet mark, in its own colours.
          Image("GoogleMeet")
            .resizable()
            .scaledToFit()
            .frame(width: 16, height: 16)
        } else {
          Image(systemName: "mappin.and.ellipse")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Palette.mutedForeground)
        }
      }
      .frame(width: 16)
      Group {
        if draft.meet {
          Text("Google Meet")
            .font(.sans(TextSize.sm, .medium))
            .foregroundStyle(Palette.meet)
        } else {
          TextField("Add location", text: $draft.location)
            .textFieldStyle(.plain)
            .font(.sans(TextSize.sm, .medium))
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      // The web's "Where" switch, drawn as a Mac segmented control (see
      // SegmentThumb for why not the stock one).
      HStack(spacing: 2) {
        WhereTab(label: "In person", active: !draft.meet, thumb: whereThumb) { setMeet(false) }
        WhereTab(label: "Video", active: draft.meet, accent: Palette.meet, thumb: whereThumb) { setMeet(true) }
      }
      .padding(2)
      .background(Palette.foreground.opacity(0.06), in: .rect(cornerRadius: 8, style: .continuous))
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Where")
    }
    .frame(minHeight: 24)
  }

  private func setMeet(_ meet: Bool) {
    withAnimation(.snappy(duration: 0.2)) { draft.meet = meet }
  }

  /// Guests: search the people directory or type any address (GuestField).
  @ViewBuilder private var guestsRow: some View {
    if capabilities?.canSeeGuests != false {
      GuestField(
        guests: $draft.guests,
        text: $guestText,
        people: data.people,
        readOnlyReason: capabilities.flatMap { $0.canInviteOthers ? nil : ($0.readOnlyReason ?? "Only the organiser can change the guests") }
      )
    }
  }

  // MARK: Footer

  private var footer: some View {
    HStack(spacing: 6) {
      calendarMenu
      ColorButton(color: $draft.color, calendarKey: calendar?.colorKey ?? .neutral)
      Button {
        draft.busy.toggle()
      } label: {
        Text(draft.busy ? "Busy" : "Free")
          .font(.sans(TextSize.xs, .medium))
          .foregroundStyle(draft.busy ? Palette.foreground : Palette.mutedForeground)
          .padding(.horizontal, 8)
          .frame(height: 24)
          .background(Palette.foreground.opacity(0.08), in: .capsule)
          .contentShape(.capsule)
      }
      .buttonStyle(.plain)
      .help(draft.busy ? "Shown as busy. Click to show as free." : "Shown as free. Click to show as busy.")

      Spacer(minLength: 8)

      Button("Cancel", action: island.cancel)
        .buttonStyle(.plain)
        .font(.sans(TextSize.sm, .medium))
        .foregroundStyle(Palette.mutedForeground)
        .padding(.horizontal, 6)

      if editing == nil {
        Button(action: submit) { submitLabel("Create", busy: "Creating…") }
          .modifier(PrimaryButton())
          .disabled(!draft.isValid || submitting)
          .keyboardShortcut(.return, modifiers: .command)
          .help("Create (⌘↩)")
      } else if isRecurring {
        // The reach of the change is the confirmation: no save under an
        // assumed scope, so ⌘↩ opens nothing here.
        Menu {
          Section("Apply changes to") {
            ForEach(saveScopes, id: \.self) { scope in
              if scope != .thisAndFollowing || capabilities?.isOrganizer != false {
                Button(scope.label) { save(scope) }
              }
            }
          }
        } label: {
          // A stock menu won't take the prominent glass style: the capsule
          // is drawn to match Create.
          HStack(spacing: 5) {
            submitLabel("Save", busy: "Saving…")
            if !submitting {
              Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).opacity(0.8)
            }
          }
          .foregroundStyle(Palette.primaryForeground)
          .padding(.horizontal, 10)
          .frame(height: 28)
          .background(Palette.primary.opacity(draft.isValid ? 1 : 0.5), in: .capsule)
          .contentShape(.capsule)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(!draft.isValid || submitting)
        .help("Save this event, or more of the series")
      } else {
        Button(action: submit) { submitLabel("Save", busy: "Saving…") }
          .modifier(PrimaryButton())
          .disabled(!draft.isValid || submitting)
          .keyboardShortcut(.return, modifiers: .command)
          .help("Save (⌘↩)")
      }
    }
  }

  private func submitLabel(_ text: String, busy: String) -> some View {
    HStack(spacing: 6) {
      if submitting { ProgressView().controlSize(.mini) }
      Text(submitting ? busy : text)
    }
    .font(.sans(TextSize.sm, .medium))
    .padding(.horizontal, 4)
  }

  @ViewBuilder private var calendarMenu: some View {
    if editing != nil {
      // Moving an event between calendars needs the provider's move, which
      // isn't built: an edit shows the calendar without offering a change.
      calendarLabel
        .padding(.horizontal, 8)
        .frame(height: 24)
        .frame(maxWidth: 130, alignment: .leading)
        .background(Palette.foreground.opacity(0.08), in: .capsule)
        .fixedSize(horizontal: true, vertical: false)
        .help("Calendar. Events can't be moved to another calendar here.")
    } else {
      calendarPicker
    }
  }

  private var calendarLabel: some View {
    HStack(spacing: 6) {
      Circle().fill(Palette.event(calendar?.colorKey ?? .neutral)).frame(width: 8, height: 8)
      Text(calendar?.displayName ?? "Calendar")
        .lineLimit(1)
        .truncationMode(.tail)
    }
    .font(.sans(TextSize.xs, .medium))
  }

  private var calendarPicker: some View {
    Menu {
      Picker("Calendar", selection: Binding(get: { calendar?.id }, set: { draft.calendarId = $0 })) {
        ForEach(data.writableCalendars) { item in
          Label {
            Text(item.displayName)
          } icon: {
            Image(systemName: "circle.fill")
          }
          .tint(Palette.event(item.colorKey))
          .tag(Optional(item.id))
        }
      }
      .pickerStyle(.inline)
      .labelsHidden()
    } label: {
      calendarLabel
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .padding(.horizontal, 8)
    .frame(height: 24)
    .frame(maxWidth: 130, alignment: .leading)
    .background(Palette.foreground.opacity(0.08), in: .capsule)
    .fixedSize(horizontal: true, vertical: false)
    .help("Calendar")
  }

  // MARK: Submit

  /// Return in the title or ⌘↩: create, or save a single event. A repeating
  /// one saves only through the scope menu.
  private func submit() {
    guard editing == nil else {
      if !isRecurring { save(.thisEvent) }
      return
    }
    guard draft.isValid, !submitting else { return }
    takeTypedGuest()
    submitting = true
    let key = operationId ?? UUID().uuidString
    operationId = key
    let draft = draft
    // Only an explicit pick is sent; unset, the server resolves the default
    // the same way `defaultCalendar` previews it.
    let calendarId = draft.calendarId ?? data.defaultCalendar?.id
    Task {
      do {
        try await data.createEvent(draft, calendarId: calendarId, zone: zone, operationId: key)
        operationId = nil
        island.close()
      } catch {
        submitting = false
        data.announce("Couldn't create event. \(Self.reason(error))")
      }
    }
  }

  /// An address typed but not yet added still counts.
  private func takeTypedGuest() {
    guard capabilities?.canInviteOthers != false,
      let typed = GuestField.typedGuest(guestText, existing: draft.guests)
    else { return }
    draft.guests.append(typed)
    guestText = ""
  }

  /// Sends what the edit changed, then goes back to the event. Nothing
  /// changed is a save too.
  private func save(_ scope: EditScope) {
    guard let event = editing, draft.isValid, !submitting else { return }
    takeTypedGuest()
    let patch = EventPatch(from: initial, to: draft, event: event, zone: zone)
    guard !patch.isEmpty else {
      island.cancel()
      return
    }
    submitting = true
    let key = operationId ?? UUID().uuidString
    operationId = key
    let zone = zone
    Task {
      do {
        try await data.updateEvent(event, patch: patch, scope: scope, zone: zone, operationId: key)
        operationId = nil
        island.cancel()
      } catch {
        submitting = false
        data.announce("Couldn't save the event. \(Self.reason(error))")
      }
    }
  }

  private static func reason(_ error: Error) -> String {
    if case ClientError.ConvexError(let data) = error {
      return data.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
    }
    return "Check your connection and try again."
  }
}

// MARK: - Pieces

/// The form's filled capsule: Create or Save.
struct PrimaryButton: ViewModifier {
  func body(content: Content) -> some View {
    content
      .buttonStyle(.glassProminent)
      .buttonBorderShape(.capsule)
      .tint(Palette.primary)
      .foregroundStyle(Palette.primaryForeground)
  }
}

/// A labelled row: a leading glyph, the label, and the control at the end.
private struct SettingRow<Control: View>: View {
  let symbol: String
  let label: String
  @ViewBuilder var control: Control

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Palette.mutedForeground)
        .frame(width: 16)
      Text(label).foregroundStyle(Palette.mutedForeground)
      Spacer(minLength: 8)
      control
    }
    .frame(minHeight: 24)
  }
}

/// A setting's current value, drawn as the menu's trigger.
private struct MenuLabel: View {
  let text: String

  init(_ text: String) { self.text = text }

  var body: some View {
    HStack(spacing: 4) {
      Text(text).lineLimit(1)
      Image(systemName: "chevron.up.chevron.down")
        .font(.system(size: 8, weight: .semibold))
        .foregroundStyle(Palette.mutedForeground)
    }
    .font(.sans(TextSize.sm, .medium))
  }
}

private struct SettingMenuStyle: ViewModifier {
  func body(content: Content) -> some View {
    content
      .menuStyle(.button)
      .buttonStyle(.plain)
      .menuIndicator(.hidden)
      .fixedSize()
  }
}

/// One end of the range: the day and, for a timed event, the time, each a
/// chip that opens its picker in a popover above the form (the web's
/// `DayPicker` and the availability panel's `TimeField` wheels).
private struct TimeRow: View {
  let label: String
  let ms: Double
  let allDay: Bool
  /// The earliest day allowed: the end cannot land before the start's day.
  let minDay: Date?
  let navigation: CalendarNavigation
  let set: (Double) -> Void

  @State private var pickingDay = false
  @State private var pickingTime = false

  var body: some View {
    let zone = navigation.zone
    let date = Date(ms: ms)
    HStack(spacing: 8) {
      Text(label)
        .foregroundStyle(Palette.mutedForeground)
        .frame(width: 44, alignment: .leading)
      PickerChip(text: zone.format(date, "EEE, MMM d, yyyy"), open: pickingDay) {
        pickingDay.toggle()
      }
      .popover(isPresented: $pickingDay, arrowEdge: .top) {
        DayPicker(selected: date, zone: zone, weekStartsOn: navigation.weekStartsOn, minDay: minDay) { day in
          setDay(day)
          pickingDay = false
        }
      }
      .accessibilityLabel("\(label) on \(zone.format(date, "EEEE, MMMM d, yyyy"))")
      Spacer(minLength: 0)
      if !allDay {
        PickerChip(
          text: zone.format(date, timePattern(use24h: navigation.use24h)),
          open: pickingTime,
          filled: true
        ) {
          pickingTime.toggle()
        }
        .popover(isPresented: $pickingTime, arrowEdge: .top) {
          TimeWheels(ms: ms, zone: zone, use24h: navigation.use24h, set: set)
        }
        .accessibilityLabel("\(label) at \(zone.format(date, timePattern(use24h: navigation.use24h)))")
        .transition(.opacity)
      }
    }
    .frame(minHeight: 26)
    #if DEBUG
      // `-QaliPicker day|time` opens the Starts row's picker after launch.
      .task {
        guard label == "Starts", let which = UserDefaults.standard.string(forKey: "QaliPicker") else { return }
        try? await Task.sleep(for: .seconds(1))
        if which == "day" { pickingDay = true } else if which == "time" { pickingTime = true }
      }
    #endif
  }

  /// Moves this end onto the picked day, keeping its time of day.
  private func setDay(_ day: Date) {
    let calendar = navigation.zone.calendar
    let time = calendar.dateComponents([.hour, .minute], from: Date(ms: ms))
    if let next = calendar.date(bySettingHour: time.hour ?? 0, minute: time.minute ?? 0, second: 0, of: day) {
      set(next.ms)
    }
  }
}

/// A value that opens its picker: the day as text with a hover fill, the
/// time as a pill like the web's time field.
struct PickerChip: View {
  let text: String
  let open: Bool
  var filled = false
  let action: () -> Void

  @State private var hovering = false

  var body: some View {
    let fill = open ? 0.12 : hovering ? (filled ? 0.12 : 0.08) : filled ? 0.07 : 0
    Button(action: action) {
      Text(text)
        .font(.sans(TextSize.sm, .medium))
        .monospacedDigit()
        .foregroundStyle(Palette.foreground)
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(Palette.foreground.opacity(fill), in: .capsule)
        .contentShape(.capsule)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
  }
}

/// The event's colour: a swatch that opens the palette, with the calendar's
/// own colour first.
private struct ColorButton: View {
  @Binding var color: String?
  let calendarKey: EventPaletteKey
  @State private var open = false

  private var key: EventPaletteKey {
    color.flatMap { choice in eventColorChoices.first { $0.color == choice }?.key } ?? calendarKey
  }

  var body: some View {
    Button {
      open.toggle()
    } label: {
      Circle()
        .fill(Palette.event(key))
        .frame(width: 12, height: 12)
        .frame(width: 24, height: 24)
        .background(Palette.foreground.opacity(0.08), in: .circle)
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .help("Event colour")
    .accessibilityLabel("Event colour")
    .popover(isPresented: $open, arrowEdge: .top) {
      HStack(spacing: 6) {
        swatch(calendarKey, selected: color == nil, label: "Calendar colour") { color = nil }
        Palette.border.frame(width: 1, height: 18)
        ForEach(eventColorChoices, id: \.color) { choice in
          swatch(choice.key, selected: color == choice.color, label: "Colour \(choice.color)") {
            color = choice.color
          }
        }
      }
      .padding(10)
    }
  }

  private func swatch(_ key: EventPaletteKey, selected: Bool, label: String, action: @escaping () -> Void) -> some View {
    Button {
      action()
      open = false
    } label: {
      Circle()
        .fill(Palette.event(key))
        .frame(width: 18, height: 18)
        .overlay {
          if selected {
            Image(systemName: "checkmark")
              .font(.system(size: 9, weight: .bold))
              .foregroundStyle(.white)
          }
        }
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .help(label)
    .accessibilityLabel(label)
  }
}

private struct WhereTab: View {
  let label: String
  let active: Bool
  var accent: Color = Palette.foreground
  let thumb: Namespace.ID
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.sans(TextSize.xs, .medium))
        .foregroundStyle(active ? accent : hovering ? Palette.foreground : Palette.mutedForeground)
        .padding(.horizontal, 9)
        .frame(height: 20)
        .background {
          if active {
            SegmentThumb(cornerRadius: 6)
              .matchedGeometryEffect(id: "thumb", in: thumb)
          } else if hovering {
            RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Palette.foreground.opacity(0.04))
          }
        }
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .accessibilityAddTraits(active ? .isSelected : [])
  }
}

/// Lays its children out in rows, wrapping at the available width.
struct FlowLayout: Layout {
  var spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = rows(width: proposal.width ?? .infinity, subviews: subviews)
    let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(rows.count - 1, 0))
    let width = rows.map(\.width).max() ?? 0
    return CGSize(width: proposal.width ?? width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for row in rows(width: bounds.width, subviews: subviews) {
      var x = bounds.minX
      for index in row.indices {
        let size = subviews[index].sizeThatFits(.unspecified)
        subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
      y += row.height + spacing
    }
  }

  private struct Row {
    var indices: [Int] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func rows(width: CGFloat, subviews: Subviews) -> [Row] {
    var rows: [Row] = [Row()]
    for index in subviews.indices {
      let size = subviews[index].sizeThatFits(.unspecified)
      let needed = rows[rows.count - 1].indices.isEmpty ? size.width : rows[rows.count - 1].width + spacing + size.width
      if needed > width, !rows[rows.count - 1].indices.isEmpty {
        rows.append(Row())
      }
      var row = rows[rows.count - 1]
      row.width = row.indices.isEmpty ? size.width : row.width + spacing + size.width
      row.height = max(row.height, size.height)
      row.indices.append(index)
      rows[rows.count - 1] = row
    }
    return rows.filter { !$0.indices.isEmpty }
  }
}

/// The form's line under the title: the description's first words, or "Add
/// description"; it opens the description screen.
private struct DescriptionLink: View {
  let preview: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Text(preview.isEmpty ? "Add description" : preview)
        .font(.sans(TextSize.sm))
        .foregroundStyle(hovering ? Palette.foreground : Palette.mutedForeground)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .accessibilityLabel(preview.isEmpty ? "Add description" : "Description: \(preview)")
  }
}

extension AnyTransition {
  /// The drill-down between the form and the description: the screen going
  /// deeper slides in from the trailing side, the one it covers drifts the
  /// other way, both fading through a touch of blur, as the island's faces do.
  static func drillDown(forward: Bool) -> AnyTransition {
    let travel: CGFloat = forward ? 24 : -24
    return .modifier(
      active: DrillDown(x: travel, opacity: 0, blur: 4),
      identity: DrillDown(x: 0, opacity: 1, blur: 0)
    )
  }
}

private struct DrillDown: ViewModifier {
  let x: CGFloat
  let opacity: Double
  let blur: CGFloat

  func body(content: Content) -> some View {
    content.offset(x: x).opacity(opacity).blur(radius: blur)
  }
}

extension EventDraft {
  /// The edit form's draft: the event's own values, with the description's
  /// one-line preview for the form.
  static func editing(_ event: CalendarEvent, zone: WorkingZone) -> EventDraft {
    var draft = EventDraft(event: event, zone: zone)
    draft.notesPreview = event.description.map { DescriptionHTML.preview(from: DescriptionHTML.attributed(from: $0)) } ?? ""
    return draft
  }
}
