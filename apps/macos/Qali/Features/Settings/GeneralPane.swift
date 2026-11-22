import SwiftUI

/// Who is signed in, the appearance, and what the calendar opens to.
struct GeneralPane: View {
  @Environment(AppModel.self) private var model
  @State private var theme = AppTheme.stored
  @State private var confirmSignOut = false
  @State private var isSigningOut = false
  @State private var error: String?

  var body: some View {
    Form {
      Section("Account") {
        if model.phase == .signedIn {
          HStack(spacing: 12) {
            UserAvatar(size: 40)
            VStack(alignment: .leading, spacing: 2) {
              Text(model.user?.name ?? " ").font(.headline)
              Text(model.user?.email ?? " ").foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .truncationMode(.middle)
            Spacer()
            Button(isSigningOut ? "Signing Out…" : "Sign Out…") { confirmSignOut = true }
              .disabled(isSigningOut)
          }
          .padding(.vertical, 2)
        } else {
          LabeledContent("Not signed in") {
            Button(model.isSigningIn ? "Signing In…" : "Sign In with Google…") {
              Task { await model.signIn() }
            }
            .disabled(model.isSigningIn)
          }
        }
      }

      Section("Appearance") {
        Picker("Theme", selection: $theme) {
          ForEach(AppTheme.allCases, id: \.self) { option in
            Label(option.label, systemImage: option.symbol).tag(option)
          }
        }
        .onChange(of: theme) { _, next in next.apply() }
      }

      if let data = model.calendarData {
        DefaultViewSection(data: data, error: $error)
      }

      #if DEBUG
        HapticTuningSection()
      #endif

      UpdatesSection()
    }
    .formStyle(.grouped)
    .saveErrors($error)
    .confirmationDialog("Sign out of qali?", isPresented: $confirmSignOut) {
      Button("Sign Out", role: .destructive) {
        isSigningOut = true
        Task {
          await model.signOut()
          isSigningOut = false
        }
      }
    } message: {
      Text("You can sign back in with the same Google account.")
    }
  }
}

private struct DefaultViewSection: View {
  let data: CalendarData
  @Binding var error: String?
  @State private var view = "week"
  @AppStorage(EventDrag.hapticsKey) private var haptics = true

  var body: some View {
    Section("Calendar") {
      SettingsRow("Default view", detail: "What the calendar opens to") {
        Picker("Default view", selection: $view) {
          Text("Day").tag("day")
          Text("Week").tag("week")
          Text("Month").tag("month")
        }
        .labelsHidden()
        .fixedSize()
      }

      SettingsRow("Haptic feedback", detail: "Tap the trackpad as events snap while you drag them") {
        Toggle("Haptic feedback", isOn: $haptics)
          .toggleStyle(.switch)
          .labelsHidden()
      }
    }
    .onChange(of: data.preferences?.raw.defaultView, initial: true) { _, stored in
      view = stored ?? "week"
    }
    .onChange(of: view) { _, next in
      guard next != (data.preferences?.raw.defaultView ?? "week") else { return }
      save("Couldn't save the default view.", into: $error) {
        try await data.updatePreferences(PreferencesPatch(defaultView: next))
      }
    }
  }
}

#if DEBUG
  /// Knobs for DragHaptics while its defaults are being chosen: each one
  /// applies to the next drag, and Try plays it now (keep a finger on the
  /// trackpad, as a click's release does). Read back with
  /// `defaults read com.myqali.macos.dev | grep hapticTune`.
  private struct HapticTuningSection: View {
    private typealias Pattern = DragHaptics.Pattern
    private static let base = DragHaptics.Tuning()
    private static func key(_ name: String) -> String { DragHaptics.Tuning.prefix + name }

    @AppStorage(key("pickUp")) private var pickUp = base.pickUp
    @AppStorage(key("snap")) private var snap = base.snap
    @AppStorage(key("day")) private var day = base.day
    @AppStorage(key("resize")) private var resize = base.resize
    @AppStorage(key("drop")) private var drop = base.drop
    @AppStorage(key("stepMinutes")) private var stepMinutes = Double(base.stepMinutes)
    @AppStorage(key("minimumGapMs")) private var minimumGapMs = base.minimumGapMs
    @AppStorage(key("dayEchoMs")) private var dayEchoMs = base.dayEchoMs
    @AppStorage(key("onFrame")) private var onFrame = base.onFrame

    var body: some View {
      Section {
        pattern("Pick up", "When a drag starts", $pickUp)
        pattern("Snap", "Each step a moving card reaches", $snap)
        pattern("Day change", "Crossing into another day", $day, echo: true)
        pattern("Resize", "Each step a dragged edge reaches", $resize)
        pattern("Drop", "Letting go somewhere new", $drop)

        SettingsRow("Tap every", detail: "Steps a card taps on; the grid snaps to 15 minutes") {
          Picker("Tap every", selection: $stepMinutes) {
            Text("15 min").tag(15.0)
            Text("30 min").tag(30.0)
            Text("Hour").tag(60.0)
          }
          .labelsHidden()
          .fixedSize()
        }
        slider("Minimum gap", "Skips snaps closer together than this", $minimumGapMs, in: 0...150)
        slider("Day change echo", "A second knock this long after the first; 0 for one", $dayEchoMs, in: 0...120) {
          DragHaptics.play(day, echoMs: dayEchoMs, onFrame: onFrame)
        }
        SettingsRow("Sync to frame", detail: "Tap as the card is drawn in place, not as the pointer moves") {
          Toggle("Sync to frame", isOn: $onFrame).toggleStyle(.switch).labelsHidden()
        }
        HStack {
          Button("Reset to Defaults", action: reset)
          Spacer()
          Button("Copy Values", action: copy)
        }
      } header: {
        Text("Haptics tuning (debug)")
      } footer: {
        Text("Each change applies to the next drag. Try plays it as soon as the click comes up, so leave your finger on the trackpad.")
          .foregroundStyle(.secondary)
      }
    }

    private func pattern(_ title: String, _ detail: String, _ selection: Binding<Pattern>, echo: Bool = false) -> some View {
      SettingsRow(title, detail: detail) {
        HStack {
          Picker(title, selection: selection) {
            ForEach(Pattern.allCases) { Text($0.label).tag($0) }
          }
          .labelsHidden()
          .fixedSize()
          Button("Try") {
            DragHaptics.play(selection.wrappedValue, echoMs: echo ? dayEchoMs : 0, onFrame: false)
          }
          .disabled(selection.wrappedValue == .off)
        }
      }
    }

    private func slider(
      _ title: String, _ detail: String, _ value: Binding<Double>, in range: ClosedRange<Double>,
      try play: (() -> Void)? = nil
    ) -> some View {
      SettingsRow(title, detail: detail) {
        HStack {
          Slider(value: value, in: range, step: 10).frame(width: 140).labelsHidden()
          Text("\(Int(value.wrappedValue)) ms")
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .frame(width: 50, alignment: .trailing)
          if let play { Button("Try", action: play) }
        }
      }
    }

    private func reset() {
      for name in ["pickUp", "snap", "day", "resize", "drop", "stepMinutes", "minimumGapMs", "dayEchoMs", "onFrame"] {
        UserDefaults.standard.removeObject(forKey: Self.key(name))
      }
    }

    private func copy() {
      let text = """
        pickUp: \(pickUp.rawValue), snap: \(snap.rawValue), day: \(day.rawValue), \
        resize: \(resize.rawValue), drop: \(drop.rawValue), stepMinutes: \(Int(stepMinutes)), \
        minimumGapMs: \(Int(minimumGapMs)), dayEchoMs: \(Int(dayEchoMs)), onFrame: \(onFrame)
        """
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    }
  }
#endif

/// Sparkle's preferences, in Release builds (see AppUpdater).
private struct UpdatesSection: View {
  @Bindable private var updater = AppUpdater.shared

  var body: some View {
    Section("Updates") {
      LabeledContent("Version", value: AppUpdater.version)
      if updater.status != .idle {
        LabeledContent("Status") { UpdatePill(status: updater.status) }
      }
      if updater.isEnabled {
        Toggle("Check for updates automatically", isOn: $updater.automaticallyChecks)
        Toggle("Download and install updates automatically", isOn: $updater.automaticallyDownloads)
          .disabled(!updater.automaticallyChecks)
        SettingsRow("Last checked", detail: lastCheckText) {
          Button("Check Now") { updater.checkForUpdates() }
            .disabled(!updater.canCheckForUpdates)
        }
      }
    }
  }

  private var lastCheckText: String {
    guard let date = updater.lastCheck else { return "Never" }
    return date.formatted(.relative(presentation: .named))
  }
}
