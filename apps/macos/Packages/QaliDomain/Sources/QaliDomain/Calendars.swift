// Port of packages/domain/src/calendar/calendars.ts.

/// Whether events can be written to a calendar — the single client-side
/// source for the writability rule.
public func isWritableCalendar(accessRole: String?) -> Bool {
  writableAccessRoles.contains(accessRole ?? "")
}

/// User-facing calendar name, including a per-user override when one exists.
public func calendarDisplayName(
  providerCalendarId: String?,
  summary: String?,
  summaryOverride: String?
) -> String {
  summaryOverride ?? summary ?? providerCalendarId ?? ""
}
