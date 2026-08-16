import type {
  CalendarEventPatchBody,
  RawCalendarDateTime,
  RawEvent,
} from "./client";

export interface LiveAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
  comment?: string;
  additionalGuests?: number;
  resource?: boolean;
}

export interface RequestedAttendee {
  email: string;
  displayName?: string;
  optional?: boolean;
}

/** Google PATCH replaces attendees wholesale. Start from the latest full
 * Google objects, retain the organizer/self entries, and preserve every live
 * RSVP/resource field for requested attendees. */
export function mergeLiveAttendees(
  live: LiveAttendee[],
  requested: RequestedAttendee[],
): LiveAttendee[] {
  const byEmail = new Map(
    live
      .filter((attendee): attendee is LiveAttendee & { email: string } =>
        Boolean(attendee.email),
      )
      .map((attendee) => [attendee.email.toLowerCase(), attendee]),
  );
  const result: LiveAttendee[] = live.filter(
    (attendee) => !attendee.email || attendee.organizer || attendee.self,
  );
  const included = new Set(
    result.flatMap((attendee) =>
      attendee.email ? [attendee.email.toLowerCase()] : [],
    ),
  );

  for (const attendee of requested) {
    const key = attendee.email.toLowerCase();
    if (included.has(key)) continue;
    const current = byEmail.get(key);
    result.push({
      ...current,
      email: attendee.email,
      ...(attendee.displayName !== undefined
        ? { displayName: attendee.displayName }
        : {}),
      ...(attendee.optional !== undefined ? { optional: attendee.optional } : {}),
    });
    included.add(key);
  }
  return result;
}

function sameGoogleTime(
  actual: RawCalendarDateTime | undefined,
  expected: RawCalendarDateTime | undefined,
): boolean {
  if (!expected) return true;
  if (expected.date !== undefined) return actual?.date === expected.date;
  if (expected.dateTime === undefined || actual?.dateTime === undefined) return false;
  return new Date(actual.dateTime).getTime() === new Date(expected.dateTime).getTime();
}

function attendeeKeys(attendees: LiveAttendee[] | undefined): string[] {
  return (attendees ?? [])
    .flatMap((attendee) =>
      attendee.email
        ? [`${attendee.email.toLowerCase()}:${attendee.optional === true ? "optional" : "required"}`]
        : [],
    )
    .sort();
}

/** Whether a retry-safe patch is already visible in Google's live event. */
export function googleEventMatchesPatch(
  event: RawEvent,
  patch: CalendarEventPatchBody,
  conference: "add" | "remove" | undefined,
): boolean {
  const stringFieldMatches = (
    actual: string | undefined,
    expected: string | null | undefined,
  ) =>
    expected === undefined ||
    (expected === null ? actual === undefined : actual === expected);

  if (!stringFieldMatches(event.summary, patch.summary)) return false;
  if (!stringFieldMatches(event.description, patch.description)) return false;
  if (!stringFieldMatches(event.location, patch.location)) return false;
  if (!stringFieldMatches(event.colorId, patch.colorId)) return false;
  if (!stringFieldMatches(event.visibility, patch.visibility)) return false;
  if (!stringFieldMatches(event.transparency, patch.transparency)) return false;
  if (!sameGoogleTime(event.start, patch.start)) return false;
  if (!sameGoogleTime(event.end, patch.end)) return false;
  if (
    patch.recurrence !== undefined &&
    JSON.stringify(event.recurrence ?? []) !== JSON.stringify(patch.recurrence)
  ) {
    return false;
  }
  if (
    patch.attendees !== undefined &&
    attendeeKeys(event.attendees).join("\n") !== attendeeKeys(patch.attendees).join("\n")
  ) {
    return false;
  }
  const hasConference = Boolean(event.hangoutLink || event.conferenceData);
  if (conference === "add" && !hasConference) return false;
  if (conference === "remove" && hasConference) return false;
  return true;
}

/** Google event IDs accept base32hex characters. UUID operation IDs already
 * fit after punctuation is removed, and make event creation retry-safe. */
export function googleEventIdForOperation(operationId: string): string {
  const safe = operationId.toLowerCase().replace(/[^a-v0-9]/g, "");
  return `qali${safe}`.slice(0, 100);
}
