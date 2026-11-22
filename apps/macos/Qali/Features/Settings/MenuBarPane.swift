import QaliDomain
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
  @AppStorage(MenuBarPrefs.clockIncludesYours) private var clockIncludesYours = true
  @AppStorage(MenuBarPrefs.clockDetails) private var clockDetails = true
  @AppStorage(MenuBarPrefs.clockIcons) private var clockIcons = true
  @AppStorage(MenuBarPrefs.clockZone) private var clockZone = ""
  @AppStorage(ZoneRailPrefs.zones) private var railZones = ""
  @AppStorage(MenuBarPrefs.hideDockIcon) private var hideDockIcon = false

  @State private var openAtLogin = SMAppService.mainApp.status == .enabled
  @State private var loginError: String?

  private var style: MenuBarStyle { MenuBarStyle(rawValue: styleRaw) ?? .nextUp }
  private var railIdentifiers: [String] { ZoneRailPrefs.zones(railZones).map(\.identifier) }

  /// The picked zone, or the rail's first while none is picked (or the
  /// picked one has left the rail), as the menu bar item reads it.
  private var clockZoneBinding: Binding<String> {
    Binding(
      get: { MenuBarPrefs.clockZone(clockZone, rail: railZones)?.identifier ?? "" },
      set: { clockZone = $0 }
    )
  }

  var body: some View {
    Form {
      Section {
        SettingsRow("Show qali in the menu bar", detail: "Your next event next to the clock, and today's agenda a click away") {
          Toggle("Show qali in the menu bar", isOn: $enabled)
            .toggleStyle(.switch)
            .labelsHidden()
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
          SettingsRow("Show the next event", detail: "Further out, the menu bar shows today's date") {
            Picker("Show the next event", selection: $lookahead) {
              Text("30 minutes ahead").tag(30)
              Text("1 hour ahead").tag(60)
              Text("3 hours ahead").tag(180)
              Text("Any time today").tag(0)
            }
            .labelsHidden()
            .fixedSize()
          }

          SettingsRow("Show event titles", detail: "Off shows only the countdown, for screen sharing") {
            Toggle("Show event titles", isOn: $showTitles)
              .toggleStyle(.switch)
              .labelsHidden()
          }

          SettingsRow("Show Join before calls", detail: "From a minute before a call with a video link") {
            Toggle("Show Join before calls", isOn: $joinPill)
              .toggleStyle(.switch)
              .labelsHidden()
          }
        }

        if style == .worldClock {
          if railIdentifiers.isEmpty {
            Text("Add time zones in Date & Time › Other time zones; until then the menu bar shows the date.")
              .font(.footnote)
              .foregroundStyle(.secondary)
          } else {
            SettingsRow("Time zone", detail: "One of your other time zones") {
              Picker("Time zone", selection: clockZoneBinding) {
                ForEach(railIdentifiers, id: \.self) { id in
                  Text("\(zoneCode(id)) · \(zoneShortLabel(id))").tag(id)
                }
              }
              .labelsHidden()
              .fixedSize()
            }
          }
        }
      }
      .disabled(!enabled)

      Section("Panel") {
        SettingsRow("Include tomorrow", detail: "List tomorrow's events under today's") {
          Toggle("Include tomorrow", isOn: $includeTomorrow)
            .toggleStyle(.switch)
            .labelsHidden()
        }
      }
      .disabled(!enabled)

      Section {
        SettingsRow("Show a world clock in the panel", detail: "A clock for each of your time zones under the date") {
          Toggle("Show a world clock in the panel", isOn: $worldClock)
            .toggleStyle(.switch)
            .labelsHidden()
        }
        Group {
          SettingsRow("Include your time zone", detail: "Off shows only your other time zones") {
            Toggle("Include your time zone", isOn: $clockIncludesYours)
              .toggleStyle(.switch)
              .labelsHidden()
          }
          SettingsRow("Show day and offset", detail: "“Today · +1h” under each time") {
            Toggle("Show day and offset", isOn: $clockDetails)
              .toggleStyle(.switch)
              .labelsHidden()
          }
          SettingsRow("Show day and night icons", detail: "A sun from 6 AM to 6 PM there, otherwise a moon; also in the menu bar item") {
            Toggle("Show day and night icons", isOn: $clockIcons)
              .toggleStyle(.switch)
              .labelsHidden()
          }
        }
        .disabled(!worldClock)
      } header: {
        Text("World clock")
      } footer: {
        if railIdentifiers.isEmpty {
          Text("Add time zones in Date & Time › Other time zones to see them here.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      }
      .disabled(!enabled || railIdentifiers.isEmpty)

      Section("App") {
        SettingsRow("Hide the Dock icon when the window is closed", detail: "qali keeps running in the menu bar") {
          Toggle("Hide the Dock icon when the window is closed", isOn: $hideDockIcon)
            .toggleStyle(.switch)
            .labelsHidden()
        }
        .disabled(!enabled)

        SettingsRow("Open at login", detail: "Starts qali when you log in to this Mac") {
          Toggle("Open at login", isOn: Binding(get: { openAtLogin }, set: setOpenAtLogin))
            .toggleStyle(.switch)
            .labelsHidden()
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
