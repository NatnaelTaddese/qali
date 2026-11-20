import ServiceManagement
import SwiftUI

/// The menu bar companion's settings, with a live preview of the status item.
struct MenuBarPane: View {
  @AppStorage(MenuBarPrefs.enabled) private var enabled = true
  @AppStorage(MenuBarPrefs.style) private var styleRaw = MenuBarStyle.nextUp.rawValue
  @AppStorage(MenuBarPrefs.showTitles) private var showTitles = true
  @AppStorage(MenuBarPrefs.lookahead) private var lookahead = 180
  @AppStorage(MenuBarPrefs.joinPill) private var joinPill = true
  @AppStorage(MenuBarPrefs.includeTomorrow) private var includeTomorrow = true
  @AppStorage(MenuBarPrefs.worldClock) private var worldClock = true
  @AppStorage(ZoneRailPrefs.zones) private var railZones = ""
  @AppStorage(MenuBarPrefs.hideDockIcon) private var hideDockIcon = false

  @State private var openAtLogin = SMAppService.mainApp.status == .enabled
  @State private var loginError: String?

  private var style: MenuBarStyle { MenuBarStyle(rawValue: styleRaw) ?? .nextUp }

  var body: some View {
    Form {
      Section {
        Toggle(isOn: $enabled) {
          Text("Show qali in the menu bar")
          Text("Your next event next to the clock, and today's agenda a click away")
        }
      }

      Section("Menu bar item") {
        preview

        Picker("Show", selection: $styleRaw) {
          ForEach(MenuBarStyle.allCases) { style in
            Text(style.label).tag(style.rawValue)
          }
        }

        if style == .nextUp {
          Picker(selection: $lookahead) {
            Text("30 minutes ahead").tag(30)
            Text("1 hour ahead").tag(60)
            Text("3 hours ahead").tag(180)
            Text("Any time today").tag(0)
          } label: {
            Text("Show the next event")
            Text("Further out, the menu bar shows today's date")
          }

          Toggle(isOn: $showTitles) {
            Text("Show event titles")
            Text("Off shows only the countdown, for screen sharing")
          }

          Toggle(isOn: $joinPill) {
            Text("Show Join before calls")
            Text("From a minute before a call with a video link")
          }
        }
      }
      .disabled(!enabled)

      Section("Panel") {
        Toggle(isOn: $includeTomorrow) {
          Text("Include tomorrow")
          Text("List tomorrow's events under today's")
        }
        Toggle(isOn: $worldClock) {
          Text("Show other time zones")
          Text("A clock for your zone and each one in Date & Time › Other time zones")
        }
        .disabled(ZoneRailPrefs.zones(railZones).isEmpty)
      }
      .disabled(!enabled)

      Section("App") {
        Toggle(isOn: $hideDockIcon) {
          Text("Hide the Dock icon when the window is closed")
          Text("qali keeps running in the menu bar")
        }
        .disabled(!enabled)

        Toggle(isOn: Binding(get: { openAtLogin }, set: setOpenAtLogin)) {
          Text("Open at login")
          Text("Starts qali when you log in to this Mac")
        }
      }
    }
    .formStyle(.grouped)
    .saveErrors($loginError)
    .onChange(of: enabled) { _, on in
      // Without the status item a hidden Dock icon would strand the app.
      if !on { hideDockIcon = false }
    }
  }

  /// The status item as it looks right now, on a strip of menu bar.
  private var preview: some View {
    HStack(spacing: 14) {
      Spacer()
      Image(systemName: "wifi")
      MenuBarLabel()
        .padding(.vertical, 2)
        .background(.primary.opacity(0.1), in: .rect(cornerRadius: 5))
      Text(Date.now, format: .dateTime.weekday(.abbreviated).day().month(.abbreviated))
      Text(Date.now, format: .dateTime.hour().minute())
    }
    .font(.system(size: 13))
    .lineLimit(1)
    .padding(.horizontal, 12)
    .frame(height: 28)
    .background(.bar, in: .rect(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator, lineWidth: 0.5))
    .opacity(enabled ? 1 : 0.5)
    .accessibilityHidden(true)
  }

  private func setOpenAtLogin(_ on: Bool) {
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    } catch {
      loginError = on ? "Couldn't add qali to your login items." : "Couldn't remove qali from your login items."
    }
    openAtLogin = SMAppService.mainApp.status == .enabled
  }
}
