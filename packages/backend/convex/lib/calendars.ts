/**
 * Whether a Google calendar is one of Google's *generated public* calendars —
 * holidays (`en.usa#holiday@group.v.calendar.google.com`), birthdays
 * (`#contacts@group.v.calendar.google.com`), and the like. Their events are
 * byte-identical for every viewer, so we store them once in `sharedEvents`
 * rather than copying them into every user's `events`.
 *
 * The `@group.v.calendar.google.com` domain (note the `.v.`, for "virtual") is
 * the reliable marker. We intentionally do NOT treat every read-only
 * (`role: "reader"`) calendar as shared: a person's calendar shared with you
 * read-only keeps the same id across viewers but can expose different event
 * detail depending on your access, so deduping it would be unsound.
 */
export function isSharedPublicCalendar(googleCalendarId: string): boolean {
  return googleCalendarId.endsWith("@group.v.calendar.google.com");
}
