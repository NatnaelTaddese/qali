/**
 * The host's own guest-list entry on events the app creates.
 *
 * Google records the calendar owner as `organizer`/`creator` on every event,
 * but it only lists them under `attendees` when the create request includes
 * them. The guest list is the only place the UI shows the organizer (the crown
 * on the entry Google flags `organizer: true`), so an app-created event with
 * guests must ask for that entry explicitly, the way Google's own UI does.
 */

import type { Doc } from "../../_generated/dataModel";
import type { EventAttendeeInput } from "../../integrations/calendar/types";

function looksLikeEmail(value: string | undefined): value is string {
  return value !== undefined && value.includes("@");
}

/** The email Google treats as the organizer of a write target, when known.
 * Only a primary calendar qualifies: on a secondary or shared calendar the
 * organizer is the calendar itself, and listing the account would invite the
 * host as an ordinary guest (with a copy landing on their primary calendar).
 * The primary calendar's id is that email and is re-keyed by every sync, so
 * it wins over the connection's account id, which is stamped once and never
 * refreshed. Neither is guaranteed (the default calendar row may still be the
 * literal "primary"), so the caller must tolerate `undefined`. */
export function hostEmailForTarget(
  calendar: Pick<Doc<"calendars">, "primary" | "providerCalendarId">,
  connection?: Pick<Doc<"calendarConnections">, "providerAccountId">,
): string | undefined {
  if (!calendar.primary) return undefined;
  if (looksLikeEmail(calendar.providerCalendarId)) {
    return calendar.providerCalendarId;
  }
  if (looksLikeEmail(connection?.providerAccountId)) {
    return connection.providerAccountId;
  }
  return undefined;
}

/** Append the host as an accepted guest when the event has guests. A guest-less
 * event stays guest-less (Google's own UI does the same), an unknown host email
 * leaves the list alone rather than failing the write, and a host already on
 * the list is marked accepted rather than duplicated. Google flags the entry
 * `organizer` and `self` because it matches the calendar owner. */
export function withHostAttendee(
  attendees: readonly EventAttendeeInput[] | undefined,
  host: { email?: string; displayName?: string },
): readonly EventAttendeeInput[] | undefined {
  if (!attendees?.length || !looksLikeEmail(host.email)) return attendees;
  const email = host.email.trim();
  const isHost = (attendee: EventAttendeeInput) =>
    attendee.email.trim().toLowerCase() === email.toLowerCase();
  if (attendees.some(isHost)) {
    return attendees.map((attendee) =>
      isHost(attendee)
        ? { ...attendee, responseStatus: attendee.responseStatus ?? "accepted" }
        : attendee,
    );
  }
  return [
    ...attendees,
    { email, displayName: host.displayName, responseStatus: "accepted" },
  ];
}
