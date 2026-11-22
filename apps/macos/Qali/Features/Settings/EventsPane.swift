import QaliDomain
import SwiftUI

/// Where new events go and which reminders they get by default (the second
/// half of the web's Preferences section).
struct EventsPane: View {
  let data: CalendarData
  @State private var error: String?

  /// Picker tags: "auto", or a calendar id.
  @State private var calendarTag = "auto"
  /// Picker tags: "auto", "none", or "m:<minutes>"; "multi" when the stored
  /// list holds several (set on the web), shown but not offered.
  @State private var timedTag = "auto"
  @State private var allDayTag = "auto"

  private static let timedPresets: [Double] = [5, 10, 15, 30, 60, 1440]

  private var stored: StoredPreferences? { data.preferences?.raw }
  private var use24h: Bool { stored?.timeFormat == "24h" }

  var body: some View {
    Form {
      if !data.writableCalendars.isEmpty {
        Section {
          SettingsRow("Default calendar", detail: "Where new events land unless you pick one") {
          Picker("Default calendar", selection: $calendarTag) {
            Text("Automatic · primary calendar").tag("auto")
            ForEach(writableGroups) { group in
              Section(group.label ?? "") {
                ForEach(group.calendars) { calendar in
                  Label {
                    Text(calendar.displayName)
                  } icon: {
                    Image(systemName: "circle.fill").foregroundStyle(Palette.event(calendar.colorKey))
                  }
                  .tag(calendar.id)
                }
              }
            }
          }
          .labelsHidden()
          .fixedSize()
          }
        }
      }

      Section("Reminders") {
        reminderPicker(
          selection: $timedTag,
          title: "Timed events",
          subtitle: "For events that don't set their own",
          automatic: "Automatic · calendar default",
          presets: Self.timedPresets,
          allDay: false,
          count: stored?.defaultReminderMinutes?.count
        )
        reminderPicker(
          selection: $allDayTag,
          title: "All-day events",
          subtitle: "For all-day events that don't set their own",
          automatic: "Automatic · the day before at \(formatWallClockMinutes(9 * 60, use24h: use24h))",
          presets: ReminderPresets.allDay,
          allDay: true,
          count: stored?.defaultAllDayReminderMinutes?.count
        )
      }

      NotificationsSection()
    }
    .formStyle(.grouped)
    .saveErrors($error)
    .disabled(stored == nil)
    .onChange(of: stored, initial: true) { _, stored in
      calendarTag = Self.calendarTag(stored, writable: data.writableCalendars)
      timedTag = Self.reminderTag(stored?.defaultReminderMinutes)
      allDayTag = Self.reminderTag(stored?.defaultAllDayReminderMinutes)
    }
    .onChange(of: calendarTag) { _, next in
      guard next != Self.calendarTag(stored, writable: data.writableCalendars) else { return }
      save("Couldn't save the default calendar.", into: $error) {
        try await data.updatePreferences(
          next == "auto" ? PreferencesPatch(reset: [.defaultCalendarId]) : PreferencesPatch(defaultCalendarId: next)
        )
      }
    }
    .onChange(of: timedTag) { _, next in
      guard next != Self.reminderTag(stored?.defaultReminderMinutes), next != "multi" else { return }
      save("Couldn't save the default reminder.", into: $error) {
        try await data.updatePreferences(Self.patch(next, field: .defaultReminderMinutes))
      }
    }
    .onChange(of: allDayTag) { _, next in
      guard next != Self.reminderTag(stored?.defaultAllDayReminderMinutes), next != "multi" else { return }
      save("Couldn't save the all-day reminder.", into: $error) {
        try await data.updatePreferences(Self.patch(next, field: .defaultAllDayReminderMinutes))
      }
    }
  }

  /// Two accounts can each have a "Personal"; the account headings keep the
  /// choice unambiguous.
  private var writableGroups: [CalendarGroup] {
    data.calendarGroups.compactMap { group in
      let calendars = group.calendars.filter { $0.isWritable && !($0.isShared ?? false) }
      return calendars.isEmpty ? nil : CalendarGroup(id: group.id, label: group.label, calendars: calendars)
    }
  }

  @ViewBuilder
  private func reminderPicker(
    selection: Binding<String>,
    title: String,
    subtitle: String,
    automatic: String,
    presets: [Double],
    allDay: Bool,
    count: Int?
  ) -> some View {
    SettingsRow(title, detail: subtitle) {
    Picker(title, selection: selection) {
      Text(automatic).tag("auto")
      Text("None").tag("none")
      Divider()
      ForEach(presets + extra(selection.wrappedValue, presets), id: \.self) { minutes in
        Text(ReminderPresets.label(minutes, allDay: allDay, use24h: use24h)).tag("m:\(Int(minutes))")
      }
      if selection.wrappedValue == "multi", let count {
        Divider()
        Text("\(count) reminders").tag("multi")
      }
    }
    .labelsHidden()
    .fixedSize()
    }
  }

  /// A single stored offset the presets don't list (set elsewhere), so the
  /// picker can still show it.
  private func extra(_ tag: String, _ presets: [Double]) -> [Double] {
    guard tag.hasPrefix("m:"), let minutes = Double(tag.dropFirst(2)), !presets.contains(minutes) else { return [] }
    return [minutes]
  }

  private static func calendarTag(_ stored: StoredPreferences?, writable: [CalendarListItem]) -> String {
    guard let id = stored?.defaultCalendarId, writable.contains(where: { $0.id == id }) else { return "auto" }
    return id
  }

  private static func reminderTag(_ minutes: [Double]?) -> String {
    guard let minutes else { return "auto" }
    switch minutes.count {
    case 0: return "none"
    case 1: return "m:\(Int(minutes[0]))"
    default: return "multi"
    }
  }

  private static func patch(_ tag: String, field: PreferencesPatch.Field) -> PreferencesPatch {
    if tag == "auto" { return PreferencesPatch(reset: [field]) }
    let minutes: [Double] = tag == "none" ? [] : [Double(tag.dropFirst(2)) ?? 10]
    var patch = PreferencesPatch()
    if field == .defaultReminderMinutes {
      patch.defaultReminderMinutes = minutes
    } else {
      patch.defaultAllDayReminderMinutes = minutes
    }
    return patch
  }
}

/// How reminders and booking requests reach the user: macOS's permission,
/// which only System Settings can change, and qali's own sounds.
private struct NotificationsSection: View {
  @Environment(AppModel.self) private var model
  @AppStorage(NotificationSound.enabledKey) private var sounds = true

  private var notifier: Notifier { model.notifier }

  var body: some View {
    Section("Notifications") {
      SettingsRow("System notifications", detail: statusDetail) {
        switch notifier.authorization {
        case .notDetermined:
          Button("Turn On…") { Task { await notifier.requestAuthorization() } }
        default:
          Button("Open System Settings…", action: openSystemSettings)
        }
      }

      SettingsRow("Play sounds", detail: "The web app's chime for reminders and booking requests") {
        Toggle("Play sounds", isOn: $sounds)
          .toggleStyle(.switch)
          .labelsHidden()
      }
    }
    .task { await notifier.refreshAuthorization() }
  }

  private var statusDetail: String {
    switch notifier.authorization {
    case .authorized, .provisional, .ephemeral:
      "In qali while you're using it, otherwise in Notification Center"
    case .denied:
      "Off in System Settings, so they only show inside qali"
    default:
      "Show reminders and booking requests when qali isn't in front"
    }
  }

  /// System Settings › Notifications, on qali's own page.
  private func openSystemSettings() {
    let id = Bundle.main.bundleIdentifier ?? ""
    let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)")
    if let url { NSWorkspace.shared.open(url) }
  }
}
