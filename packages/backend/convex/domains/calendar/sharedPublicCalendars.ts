/**
 * Whether a Google calendar is one of Google's *generated, globally identical*
 * public calendars — i.e. holiday calendars like
 * `en.usa#holiday@group.v.calendar.google.com`. Google generates these from the
 * same source for every viewer, so their events are byte-identical no matter who
 * reads them. Only these are safe to store once in `sharedEvents` and serve to
 * any user who selects the calendar.
 *
 * We deliberately do NOT treat every `@group.v.calendar.google.com` calendar as
 * shared. That domain (note the `.v.`, for "virtual") also covers:
 *   - Birthday calendars (`...#contacts@group.v.calendar.google.com`), which are
 *     derived from the viewer's OWN contacts — personalized, not global. Sharing
 *     them across users leaks contact-derived birthdays between accounts.
 *   - User-created secondary calendars, which get a random-hash id under the same
 *     domain and whose contents differ per owner.
 * Both of those must live per-user in `events`, guarded by ownership, never in
 * the userless `sharedEvents` table.
 *
 * We also do NOT treat every read-only (`role: "reader"`) calendar as shared: a
 * person's calendar shared with you read-only keeps the same id across viewers
 * but can expose different event detail depending on your access, so deduping it
 * would be unsound.
 *
 * The allowlist is intentionally conservative — matching only the holiday shape.
 * Anything not matched here is stored per-user, which is always correct (it only
 * forgoes the storage dedup). Add further markers here only for calendars proven
 * to be identical for every viewer.
 */
export function isSharedPublicCalendar(googleCalendarId: string): boolean {
  return googleCalendarId.endsWith("#holiday@group.v.calendar.google.com");
}
