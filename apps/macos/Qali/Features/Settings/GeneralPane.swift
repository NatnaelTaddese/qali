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
