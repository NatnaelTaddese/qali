// Port of packages/domain/src/calendar/events.ts: the structural event shapes
// the calendar math reads, so it never depends on the app's DTO types.

/// What the grid math needs from an event: its identity and its bounds.
/// All-day bounds are UTC midnights (Google date-only), `endMs` exclusive.
public protocol CalendarEventLike {
  var id: String { get }
  var startMs: Double { get }
  var endMs: Double { get }
  var allDay: Bool { get }
}

/// What colour resolution needs: the provider colour key and the local
/// calendar the event belongs to (its id is the last-resort hash seed).
public protocol ColorableEventLike {
  var id: String { get }
  var color: String? { get }
  var localCalendarId: String? { get }
}
