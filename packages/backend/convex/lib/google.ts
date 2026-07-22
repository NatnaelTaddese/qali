// Plain fetch helpers for the Google Calendar and People (Contacts) REST APIs.
// These are NOT Convex functions — they run inside Convex actions (default runtime,
// no "use node" needed since we only use fetch) and return already-mapped shapes.

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const PEOPLE_BASE = "https://people.googleapis.com/v1";

/**
 * Thrown when Google returns HTTP 410 for a sync token. The caller should drop the
 * stored sync token and restart a full sync.
 */
export class SyncTokenExpiredError extends Error {
  constructor() {
    super("SYNC_TOKEN_EXPIRED");
    this.name = "SyncTokenExpiredError";
  }
}

async function googleFetch(
  url: string,
  accessToken: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    // Expired sync token: the Calendar API signals this with HTTP 410, while the
    // People API returns HTTP 400 with reason "EXPIRED_SYNC_TOKEN". Both should
    // drop the stored token and restart a full sync.
    if (
      res.status === 410 ||
      (res.status === 400 && body.includes("EXPIRED_SYNC_TOKEN"))
    ) {
      throw new SyncTokenExpiredError();
    }
    throw new Error(`Google API ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export type MappedAttendee = {
  email: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
};

export type MappedEvent = {
  googleEventId: string;
  calendarId: string;
  summary?: string;
  description?: string;
  location?: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  status: string;
  htmlLink?: string;
  colorId?: string;
  visibility?: string;
  attendees?: MappedAttendee[];
  googleUpdatedMs: number;
};

type RawCalendarDateTime = {
  dateTime?: string;
  date?: string;
  /** IANA zone; required by Google for recurring timed events. */
  timeZone?: string;
};
type RawEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  colorId?: string;
  visibility?: string;
  updated?: string;
  start?: RawCalendarDateTime;
  end?: RawCalendarDateTime;
  attendees?: {
    email?: string;
    displayName?: string;
    responseStatus?: string;
    organizer?: boolean;
    self?: boolean;
    optional?: boolean;
  }[];
};

export type CalendarPage = {
  events: MappedEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

export type MappedCalendar = {
  googleCalendarId: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  googleSelected?: boolean;
};

type RawCalendarListEntry = {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  selected?: boolean;
  hidden?: boolean;
  deleted?: boolean;
};

/** Enumerate every calendar in the user's CalendarList (paginated). */
export async function fetchCalendarList(
  accessToken: string,
): Promise<MappedCalendar[]> {
  const calendars: MappedCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      maxResults: "250",
      showDeleted: "false",
      showHidden: "false",
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    }
    const data = (await googleFetch(
      `${CALENDAR_BASE}/users/me/calendarList?${params.toString()}`,
      accessToken,
    )) as { items?: RawCalendarListEntry[]; nextPageToken?: string };

    for (const item of data.items ?? []) {
      if (item.deleted || item.hidden) {
        continue;
      }
      calendars.push({
        googleCalendarId: item.id,
        summary: item.summary,
        summaryOverride: item.summaryOverride,
        backgroundColor: item.backgroundColor,
        foregroundColor: item.foregroundColor,
        primary: item.primary,
        accessRole: item.accessRole,
        timeZone: item.timeZone,
        googleSelected: item.selected,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return calendars;
}

export function mapGoogleEvent(raw: RawEvent, calendarId: string): MappedEvent {
  const allDay = Boolean(raw.start?.date && !raw.start?.dateTime);
  const startIso = raw.start?.dateTime ?? raw.start?.date;
  const endIso = raw.end?.dateTime ?? raw.end?.date;
  const startMs = startIso ? new Date(startIso).getTime() : 0;
  const endMs = endIso ? new Date(endIso).getTime() : startMs;
  // Keep only attendees Google gave an email for (it omits email on some
  // resource rows); drop the field entirely when there are none.
  const attendees = raw.attendees
    ?.filter((a): a is typeof a & { email: string } => Boolean(a.email))
    .map((a) => ({
      email: a.email,
      displayName: a.displayName,
      responseStatus: a.responseStatus,
      organizer: a.organizer,
      self: a.self,
      optional: a.optional,
    }));
  return {
    googleEventId: raw.id,
    calendarId,
    summary: raw.summary,
    description: raw.description,
    location: raw.location,
    startMs,
    endMs,
    allDay,
    status: raw.status ?? "confirmed",
    htmlLink: raw.htmlLink,
    colorId: raw.colorId,
    visibility: raw.visibility,
    attendees: attendees && attendees.length > 0 ? attendees : undefined,
    googleUpdatedMs: raw.updated ? new Date(raw.updated).getTime() : Date.now(),
  };
}

export async function fetchCalendarPage(
  accessToken: string,
  opts: {
    calendarId: string;
    syncToken?: string;
    pageToken?: string;
    timeMinMs?: number;
  },
): Promise<CalendarPage> {
  const params = new URLSearchParams({
    singleEvents: "true",
    showDeleted: "true",
    maxResults: "250",
  });
  if (opts.pageToken) {
    params.set("pageToken", opts.pageToken);
  }
  if (opts.syncToken) {
    // syncToken cannot be combined with timeMin.
    params.set("syncToken", opts.syncToken);
  } else if (opts.timeMinMs !== undefined) {
    params.set("timeMin", new Date(opts.timeMinMs).toISOString());
  }

  const data = (await googleFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(
      opts.calendarId,
    )}/events?${params.toString()}`,
    accessToken,
  )) as {
    items?: RawEvent[];
    nextPageToken?: string;
    nextSyncToken?: string;
  };

  return {
    events: (data.items ?? []).map((e) => mapGoogleEvent(e, opts.calendarId)),
    nextPageToken: data.nextPageToken,
    nextSyncToken: data.nextSyncToken,
  };
}

export async function insertCalendarEvent(
  accessToken: string,
  calendarId: string,
  body: {
    summary: string;
    description?: string;
    location?: string;
    start: RawCalendarDateTime;
    end: RawCalendarDateTime;
    colorId?: string;
    visibility?: string;
    /** Guests to invite. Google emails them when `sendUpdates` is set. */
    attendees?: { email: string; displayName?: string; optional?: boolean }[];
    /** RFC5545 recurrence lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]. */
    recurrence?: string[];
  },
  /** When set, Google emails the affected guests (e.g. "all" for invitations). */
  sendUpdates?: "all" | "externalOnly" | "none",
): Promise<MappedEvent> {
  const query = sendUpdates ? `?sendUpdates=${sendUpdates}` : "";
  const data = (await googleFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events${query}`,
    accessToken,
    { method: "POST", body: JSON.stringify(body) },
  )) as RawEvent;
  return mapGoogleEvent(data, calendarId);
}

/** Patch an existing event's fields (e.g. a rescheduled start/end) and return
 * the re-mapped result. For a recurring series this targets a single expanded
 * instance by its `googleEventId`, so Google records a per-occurrence exception. */
export async function patchCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
  body: {
    start?: RawCalendarDateTime;
    end?: RawCalendarDateTime;
    summary?: string;
    description?: string;
    location?: string;
    colorId?: string;
    visibility?: string;
    attendees?: { email: string; displayName?: string; optional?: boolean }[];
  },
  /** When set, Google emails the affected guests (e.g. "all" for invitations). */
  sendUpdates?: "all" | "externalOnly" | "none",
): Promise<MappedEvent> {
  const query = sendUpdates ? `?sendUpdates=${sendUpdates}` : "";
  const data = (await googleFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}${query}`,
    accessToken,
    { method: "PATCH", body: JSON.stringify(body) },
  )) as RawEvent;
  return mapGoogleEvent(data, calendarId);
}

// ---------------------------------------------------------------------------
// Contacts (People API)
// ---------------------------------------------------------------------------

export type MappedContact = {
  resourceName: string;
  deleted: boolean;
  displayName?: string;
  emails: string[];
  phones: string[];
  photoUrl?: string;
  googleEtag?: string;
};

type RawPerson = {
  resourceName: string;
  etag?: string;
  metadata?: { deleted?: boolean };
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  photos?: { url?: string; default?: boolean }[];
};

export type ContactsPage = {
  contacts: MappedContact[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

export function mapGoogleContact(raw: RawPerson): MappedContact {
  return {
    resourceName: raw.resourceName,
    deleted: Boolean(raw.metadata?.deleted),
    displayName: raw.names?.[0]?.displayName,
    emails: (raw.emailAddresses ?? [])
      .map((e) => e.value)
      .filter((v): v is string => Boolean(v)),
    phones: (raw.phoneNumbers ?? [])
      .map((p) => p.value)
      .filter((v): v is string => Boolean(v)),
    photoUrl: raw.photos?.find((p) => !p.default)?.url ?? raw.photos?.[0]?.url,
    googleEtag: raw.etag,
  };
}

export async function fetchContactsPage(
  accessToken: string,
  opts: { syncToken?: string; pageToken?: string; requestSyncToken?: boolean },
): Promise<ContactsPage> {
  const params = new URLSearchParams({
    personFields: "names,emailAddresses,phoneNumbers,photos",
    pageSize: "200",
  });
  if (opts.pageToken) {
    params.set("pageToken", opts.pageToken);
  }
  if (opts.syncToken) {
    params.set("syncToken", opts.syncToken);
  }
  if (opts.requestSyncToken) {
    params.set("requestSyncToken", "true");
  }

  const data = (await googleFetch(
    `${PEOPLE_BASE}/people/me/connections?${params.toString()}`,
    accessToken,
  )) as {
    connections?: RawPerson[];
    nextPageToken?: string;
    nextSyncToken?: string;
  };

  return {
    contacts: (data.connections ?? []).map(mapGoogleContact),
    nextPageToken: data.nextPageToken,
    nextSyncToken: data.nextSyncToken,
  };
}
