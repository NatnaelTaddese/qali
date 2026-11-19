import QaliDomain
import SwiftUI

/// The form's Repeat value (the web's `RepeatControl`): the rule in words,
/// opening a popover with the presets and a full custom editor, as the
/// Starts/Ends chips open theirs.
struct RepeatField: View {
  @Binding var rule: Recurrence?
  let startMs: Double
  let navigation: CalendarNavigation

  @State private var open = false
  @State private var hovering = false

  var body: some View {
    let zone = navigation.zone
    Button {
      open.toggle()
    } label: {
      HStack(spacing: 4) {
        Text(rule?.summary(zone: zone) ?? "Does not repeat")
          .lineLimit(1)
          .truncationMode(.tail)
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 8, weight: .semibold))
          .foregroundStyle(Palette.mutedForeground)
      }
      .font(.sans(TextSize.sm, .medium))
      .padding(.horizontal, 8)
      .frame(height: 24)
      .background(Palette.foreground.opacity(open ? 0.12 : hovering ? 0.08 : 0), in: .capsule)
      .padding(.trailing, -8)
      .contentShape(.capsule)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
    .frame(maxWidth: 230, alignment: .trailing)
    .popover(isPresented: $open, arrowEdge: .top) {
      RepeatEditor(rule: $rule, startMs: startMs, zone: zone, weekStartsOn: navigation.weekStartsOn)
    }
    .accessibilityLabel("Repeat: \(rule?.summary(zone: zone) ?? "Does not repeat")")
    #if DEBUG
      // `-QaliRepeatRule "RRULE:…"` seeds the rule and `-QaliPicker repeat`
      // opens the editor, for captures.
      .task {
        let defaults = UserDefaults.standard
        if let line = defaults.string(forKey: "QaliRepeatRule") {
          rule = Recurrence.parse([line], zone: zone)
        }
        guard defaults.string(forKey: "QaliPicker") == "repeat" else { return }
        try? await Task.sleep(for: .seconds(1))
        open = true
      }
    #endif
  }
}

/// The popover: presets like menu items, then the custom rule. Any custom
/// change turns repeating on, from a weekly rule on the event's own day.
struct RepeatEditor: View {
  @Binding var rule: Recurrence?
  let startMs: Double
  let zone: WorkingZone
  let weekStartsOn: WeekStart

  @State private var pickingEndDay = false
  @Namespace private var freqThumb
  @Namespace private var endThumb

  /// The rule the custom section edits: the current one, else the default.
  private var working: Recurrence {
    rule ?? .weekly(on: Recurrence.Weekday.of(startMs, zone: zone))
  }

  private func update(_ change: (inout Recurrence) -> Void) {
    var next = working
    change(&next)
    withAnimation(.snappy(duration: 0.2)) { rule = next }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      presets
        .padding(5)
      Divider()
        .padding(.horizontal, 12)
      custom
        .padding(12)
    }
    .frame(width: 300)
    .font(.sans(TextSize.sm))
    .foregroundStyle(Palette.foreground)
  }

  // MARK: Presets

  private var presets: some View {
    let start = Date(ms: startMs)
    let day = Recurrence.Weekday.of(startMs, zone: zone)
    let choices: [(String, Recurrence?)] = [
      ("Does not repeat", nil),
      ("Daily", .daily()),
      ("Weekly on \(zone.format(start, "EEEE"))", .weekly(on: day)),
      ("Every weekday (Mon – Fri)", .everyWeekday()),
      ("Monthly on day \(zone.calendar.component(.day, from: start))", .monthly()),
      ("Annually on \(zone.format(start, "MMMM d"))", .yearly()),
    ]
    return VStack(alignment: .leading, spacing: 0) {
      ForEach(choices, id: \.0) { label, value in
        PresetRow(label: label, checked: value == rule) {
          withAnimation(.snappy(duration: 0.2)) { rule = value }
        }
      }
    }
  }

  // MARK: Custom

  private var custom: some View {
    let rule = working
    return VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text("Custom")
          .font(.sans(TextSize.xs, .medium))
          .foregroundStyle(Palette.mutedForeground)
        Spacer()
        if self.rule != nil, !isPreset(rule) {
          Image(systemName: "checkmark")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Palette.mutedForeground)
            .accessibilityLabel("Custom rule in use")
        }
      }

      LabeledRow("Repeats") {
        SegmentedChoice(
          options: Recurrence.Freq.allCases.map { ($0, $0.adverb == "Annually" ? "Yearly" : $0.adverb) },
          selection: self.rule == nil ? nil : rule.freq,
          thumb: freqThumb
        ) { freq in
          update { $0 = $0.with(freq: freq, startMs: startMs, zone: zone) }
        }
      }

      LabeledRow("Every") {
        CountField(value: rule.interval, range: 1...99, label: "Repeat interval") { n in
          update { $0.interval = n }
        }
        Text(rule.interval == 1 ? rule.freq.noun : "\(rule.freq.noun)s")
          .foregroundStyle(Palette.mutedForeground)
        Spacer(minLength: 0)
      }

      if rule.freq == .weekly {
        LabeledRow("On") {
          HStack(spacing: 4) {
            ForEach(Recurrence.Weekday.ordered(from: weekStartsOn), id: \.self) { day in
              WeekdayToggle(day: day, on: self.rule != nil && rule.byWeekday.contains(day)) {
                update { $0 = $0.toggling(day) }
              }
            }
          }
        }
        .transition(.opacity)
      }

      LabeledRow("Ends") {
        SegmentedChoice(
          options: [(EndKind.never, "Never"), (.onDate, "On date"), (.count, "After")],
          selection: self.rule == nil ? nil : EndKind(rule.end),
          thumb: endThumb
        ) { kind in
          update { $0.end = kind.defaultEnd(startMs: startMs, zone: zone) }
        }
      }

      endDetail(rule)
    }
  }

  @ViewBuilder private func endDetail(_ rule: Recurrence) -> some View {
    if self.rule != nil {
      switch rule.end {
      case .never:
        EmptyView()
      case .onDate(let dayMs):
        LabeledRow("") {
          PickerChip(text: zone.format(Date(ms: dayMs), "EEE, MMM d, yyyy"), open: pickingEndDay, filled: true) {
            pickingEndDay.toggle()
          }
          .popover(isPresented: $pickingEndDay, arrowEdge: .top) {
            DayPicker(
              selected: Date(ms: dayMs),
              zone: zone,
              weekStartsOn: weekStartsOn,
              minDay: zone.startOfDay(Date(ms: startMs))
            ) { day in
              update { $0.end = .onDate(day.ms) }
              pickingEndDay = false
            }
          }
          .accessibilityLabel("Ends on \(zone.format(Date(ms: dayMs), "EEEE, MMMM d, yyyy"))")
          Spacer(minLength: 0)
        }
        .transition(.opacity)
      case .count(let count):
        LabeledRow("") {
          CountField(value: count, range: 1...999, label: "Number of occurrences") { n in
            update { $0.end = .count(n) }
          }
          Text(count == 1 ? "time" : "times").foregroundStyle(Palette.mutedForeground)
          Spacer(minLength: 0)
        }
        .transition(.opacity)
      }
    }
  }

  private func isPreset(_ rule: Recurrence) -> Bool {
    let day = Recurrence.Weekday.of(startMs, zone: zone)
    return [Recurrence.daily(), .weekly(on: day), .everyWeekday(), .monthly(), .yearly()].contains(rule)
  }
}

/// How the series ends, as the switch picks it.
private enum EndKind: Hashable {
  case never, onDate, count

  init(_ end: Recurrence.End) {
    switch end {
    case .never: self = .never
    case .onDate: self = .onDate
    case .count: self = .count
    }
  }

  /// What switching to this kind starts on (the web's): a month after the
  /// start, or five times.
  func defaultEnd(startMs: Double, zone: WorkingZone) -> Recurrence.End {
    switch self {
    case .never: .never
    case .onDate: .onDate(zone.addingMonths(1, to: zone.startOfDay(Date(ms: startMs))).ms)
    case .count: .count(5)
    }
  }
}

// MARK: - Pieces

/// A label in a fixed column, then its controls.
private struct LabeledRow<Content: View>: View {
  let label: String
  @ViewBuilder var content: Content

  init(_ label: String, @ViewBuilder content: () -> Content) {
    self.label = label
    self.content = content()
  }

  var body: some View {
    HStack(spacing: 8) {
      Text(label)
        .foregroundStyle(Palette.mutedForeground)
        .frame(width: 52, alignment: .leading)
      content
    }
    .frame(minHeight: 26)
  }
}

/// One preset, drawn like a menu item: a check column, then the label, with
/// the menu's rounded hover.
private struct PresetRow: View {
  let label: String
  let checked: Bool
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Image(systemName: "checkmark")
          .font(.system(size: 10, weight: .semibold))
          .opacity(checked ? 1 : 0)
          .frame(width: 14)
        Text(label)
          .font(.sans(TextSize.sm, checked ? .medium : .regular))
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 6)
      .frame(height: 26)
      .background(Palette.foreground.opacity(hovering ? 0.08 : 0), in: .rect(cornerRadius: 6, style: .continuous))
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .accessibilityAddTraits(checked ? .isSelected : [])
  }
}

/// A number in a capsule between − and +: hold a button to keep counting,
/// or click the number to type one. The digits roll as they change.
private struct CountField: View {
  let value: Int
  let range: ClosedRange<Int>
  let label: String
  let set: (Int) -> Void

  @State private var editing = false
  @State private var text = ""
  @FocusState private var focused: Bool

  private func step(_ delta: Int) {
    set(min(max(value + delta, range.lowerBound), range.upperBound))
  }

  var body: some View {
    HStack(spacing: 0) {
      StepButton(symbol: "minus", label: "Fewer", enabled: value > range.lowerBound) { step(-1) }
      Group {
        if editing {
          TextField(label, text: $text)
            .textFieldStyle(.plain)
            .multilineTextAlignment(.center)
            .focused($focused)
            .onSubmit(commit)
            .onExitCommand { editing = false }
            .onAppear { focused = true }
        } else {
          Text(verbatim: "\(value)")
            .contentTransition(.numericText(value: Double(value)))
            .contentShape(.rect)
            .onTapGesture {
              text = "\(value)"
              editing = true
            }
            .help("Click to type a number")
        }
      }
      .font(.sans(TextSize.sm, .semibold))
      .monospacedDigit()
      .frame(width: range.upperBound > 99 ? 34 : 26)
      StepButton(symbol: "plus", label: "More", enabled: value < range.upperBound) { step(1) }
    }
    .padding(2)
    .background(Palette.foreground.opacity(editing ? 0.1 : 0.06), in: .capsule)
    .animation(.snappy(duration: 0.2), value: value)
    .onChange(of: focused) { _, focused in
      if !focused, editing { commit() }
    }
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
    .accessibilityValue("\(value)")
    .accessibilityAdjustableAction { direction in
      switch direction {
      case .increment: step(1)
      case .decrement: step(-1)
      @unknown default: break
      }
    }
  }

  /// Takes the typed number, clamped; anything else keeps the old one.
  private func commit() {
    if let typed = Int(text.trimmingCharacters(in: .whitespaces)) {
      set(min(max(typed, range.lowerBound), range.upperBound))
    }
    editing = false
  }

  /// A round − or +, with a hover and press fill; held down, it repeats.
  private struct StepButton: View {
    let symbol: String
    let label: String
    let enabled: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
      Button(action: action) {
        Image(systemName: symbol)
          .font(.system(size: 9, weight: .bold))
          .frame(width: 22, height: 22)
          .contentShape(.circle)
      }
      .buttonStyle(StepStyle(hovering: hovering && enabled))
      .buttonRepeatBehavior(.enabled)
      .disabled(!enabled)
      .onHover { hovering = $0 }
      .help(label)
    }
  }

  private struct StepStyle: ButtonStyle {
    let hovering: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
      configuration.label
        .foregroundStyle(isEnabled ? (hovering ? Palette.foreground : Palette.mutedForeground) : Palette.mutedForeground.opacity(0.4))
        .background(
          Palette.foreground.opacity(configuration.isPressed ? 0.16 : hovering ? 0.1 : 0),
          in: .circle
        )
        .scaleEffect(configuration.isPressed ? 0.92 : 1)
        .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
  }
}

/// A Mac segmented control drawn with the app's thumb (a stock one takes
/// the blue accent): equal segments, the chosen one lifted. Nil selection
/// shows none chosen.
private struct SegmentedChoice<Value: Hashable>: View {
  let options: [(Value, String)]
  let selection: Value?
  let thumb: Namespace.ID
  let pick: (Value) -> Void

  var body: some View {
    HStack(spacing: 2) {
      ForEach(options, id: \.0) { value, label in
        Segment(label: label, active: value == selection, thumb: thumb) { pick(value) }
      }
    }
    .padding(2)
    .background(Palette.foreground.opacity(0.06), in: .rect(cornerRadius: 8, style: .continuous))
    .accessibilityElement(children: .contain)
  }

  private struct Segment: View {
    let label: String
    let active: Bool
    let thumb: Namespace.ID
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
      Button(action: action) {
        Text(label)
          .font(.sans(TextSize.xs, .medium))
          .foregroundStyle(active || hovering ? Palette.foreground : Palette.mutedForeground)
          .lineLimit(1)
          .frame(maxWidth: .infinity)
          .frame(height: 22)
          .background {
            if active {
              SegmentThumb(cornerRadius: 6).matchedGeometryEffect(id: "thumb", in: thumb)
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
}

/// A weekday's initial in a circle, filled when the rule repeats on it.
private struct WeekdayToggle: View {
  let day: Recurrence.Weekday
  let on: Bool
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Text(day.initial)
        .font(.sans(TextSize.xs, .semibold))
        .foregroundStyle(on ? Palette.primaryForeground : hovering ? Palette.foreground : Palette.mutedForeground)
        .frame(width: 26, height: 26)
        .background(on ? Palette.primary : Palette.foreground.opacity(hovering ? 0.1 : 0.06), in: .circle)
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
    .help(day.short)
    .accessibilityLabel(day.short)
    .accessibilityAddTraits(on ? .isSelected : [])
  }
}
