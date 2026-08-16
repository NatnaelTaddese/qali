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

/** Google event IDs accept base32hex characters. UUID operation IDs already
 * fit after punctuation is removed, and make event creation retry-safe. */
export function googleEventIdForOperation(operationId: string): string {
  const safe = operationId.toLowerCase().replace(/[^a-v0-9]/g, "");
  return `qali${safe}`.slice(0, 100);
}
