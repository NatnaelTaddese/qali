import ConvexMobile
import Foundation

/// The writes the Settings window makes (the web's SettingsPanel). Each one
/// throws so the pane can say what didn't save; the live queries carry the
/// saved value back.
extension CalendarData {
  /// A partial preferences update. `reset` puts fields back to automatic.
  func updatePreferences(_ patch: PreferencesPatch) async throws {
    try await Self.mutate(client, ConvexAPI.updatePreferences) { patch.args }
  }

  func setConnection(_ connection: ConnectionListItem, active: Bool) async throws {
    let id = connection.id
    try await Self.mutate(client, ConvexAPI.setConnectionStatus) {
      ["connectionId": id, "status": active ? "active" : "paused"]
    }
  }

  func setContacts(_ connection: ConnectionListItem, enabled: Bool) async throws {
    let id = connection.id
    try await Self.mutate(client, ConvexAPI.setConnectionContacts) {
      ["connectionId": id, "contacts": enabled]
    }
  }

  /// Removes the account and, through a background purge, everything it
  /// synced.
  func disconnect(_ connection: ConnectionListItem) async throws {
    let id = connection.id
    try await Self.act(client, ConvexAPI.disconnectAccount) { ["connectionId": id] }
  }

  func setSelected(_ calendar: CalendarListItem, selected: Bool) async throws {
    let id = calendar.id
    try await Self.mutate(client, ConvexAPI.setCalendarSelected) { ["calendarId": id, "selected": selected] }
  }

  /// Renames a calendar locally; nil (or the provider's own name) clears the
  /// override.
  func rename(_ calendar: CalendarListItem, to name: String?) async throws {
    let id = calendar.id
    try await Self.mutate(client, ConvexAPI.setCalendarSummaryOverride) {
      var args: [String: ConvexEncodable?] = ["calendarId": id]
      if let name { args["summaryOverride"] = name }
      return args
    }
  }

  private nonisolated static func mutate(
    _ client: ConvexClient,
    _ name: String,
    _ args: @Sendable () -> [String: ConvexEncodable?]
  ) async throws {
    let _: SettingsIgnored = try await client.mutation(name, with: args())
  }
}

private nonisolated struct SettingsIgnored: Decodable {
  init(from decoder: Decoder) throws {}
}

/// One `updatePreferences` call. Unset fields are left as they are.
nonisolated struct PreferencesPatch: Sendable {
  enum Field: String, Sendable {
    case timeZone, timeFormat, defaultCalendarId, defaultReminderMinutes, defaultAllDayReminderMinutes
  }

  var weekStartsOn: Int?
  var timeFormat: String?
  var defaultView: String?
  var timeZone: String?
  var otherTimeZones: [String]?
  var defaultCalendarId: String?
  var defaultReminderMinutes: [Double]?
  var defaultAllDayReminderMinutes: [Double]?
  var reset: [Field] = []

  var args: [String: ConvexEncodable?] {
    var args: [String: ConvexEncodable?] = [:]
    if let weekStartsOn { args["weekStartsOn"] = Double(weekStartsOn) }
    if let timeFormat { args["timeFormat"] = timeFormat }
    if let defaultView { args["defaultView"] = defaultView }
    if let timeZone { args["timeZone"] = timeZone }
    if let otherTimeZones { args["otherTimeZones"] = otherTimeZones.map { $0 as ConvexEncodable? } }
    if let defaultCalendarId { args["defaultCalendarId"] = defaultCalendarId }
    if let defaultReminderMinutes {
      args["defaultReminderMinutes"] = defaultReminderMinutes.map { $0 as ConvexEncodable? }
    }
    if let defaultAllDayReminderMinutes {
      args["defaultAllDayReminderMinutes"] = defaultAllDayReminderMinutes.map { $0 as ConvexEncodable? }
    }
    if !reset.isEmpty { args["reset"] = reset.map { $0.rawValue as ConvexEncodable? } }
    return args
  }
}
