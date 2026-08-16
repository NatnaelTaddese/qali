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

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Unmodified diagnostic body, retained for reason-based classifications
     * such as Google's HTTP 403 rateLimitExceeded response. */
    readonly responseBody?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export class GoogleNetworkError extends Error {
  constructor(cause: unknown) {
    super(
      `Google request did not return a response: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "GoogleNetworkError";
  }
}

// Bounded retry policy for transient Google failures. Without it, a fan-out sync
// turns every 429/5xx/network blip into a synchronized failure (and, across
// users, a synchronized retry burst). Retries use full jitter so concurrent
// callers don't re-hit Google in lockstep.
const MAX_FETCH_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
// Cap on how long we'll honor a Retry-After, so a single call can't tie up an
// action for minutes.
const MAX_RETRY_AFTER_MS = 30_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a method is safe to retry after an ambiguous failure (a network drop
 * or 5xx that may have applied). Non-idempotent writes (POST/PATCH) are not — a
 * retry could duplicate a create or re-send invitations. A 429 / rate-limit
 * rejection is handled separately: it was refused before applying, so retrying it
 * is safe for any method. */
function isIdempotentMethod(init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return (
    method === "GET" ||
    method === "HEAD" ||
    method === "PUT" ||
    method === "DELETE"
  );
}

/** Full-jitter exponential backoff: a random delay in [0, min(cap, base·2^n)]. */
function backoffDelayMs(attempt: number): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.random() * ceiling;
}

/** Google's `Retry-After` as ms (seconds or HTTP-date form), clamped to a sane
 * ceiling. Returns undefined when absent or unparseable. */
function parseRetryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

async function googleFetch(
  url: string,
  accessToken: string,
  init?: RequestInit,
): Promise<unknown> {
  const idempotent = isIdempotentMethod(init);

  for (let attempt = 0; ; attempt++) {
    const lastAttempt = attempt >= MAX_FETCH_ATTEMPTS - 1;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...init?.headers,
        },
      });
    } catch (error) {
      // The request never got a response. Retry only idempotent methods — a
      // write may have committed before the connection dropped.
      if (idempotent && !lastAttempt) {
        await sleep(backoffDelayMs(attempt));
        continue;
      }
      throw new GoogleNetworkError(error);
    }

    if (!res.ok) {
      let body = "<response body unavailable>";
      try {
        body = await res.text();
      } catch {
        // The HTTP status is authoritative for a non-success response even when
        // its diagnostic body cannot be read.
      }
      // Expired sync token: the Calendar API signals this with HTTP 410, while
      // the People API returns HTTP 400 with reason "EXPIRED_SYNC_TOKEN". Both
      // should drop the stored token and restart a full sync — never retried.
      if (
        res.status === 410 ||
        (res.status === 400 && body.includes("EXPIRED_SYNC_TOKEN"))
      ) {
        throw new SyncTokenExpiredError();
      }
      // A rate-limit rejection (429, or Google's 403 rateLimitExceeded) was
      // refused before applying, so it's safe to retry for any method. A 5xx is
      // ambiguous, so only retry it for idempotent methods.
      const rateLimited =
        res.status === 429 ||
        (res.status === 403 && body.includes("ateLimitExceeded"));
      const serverError = res.status >= 500 && res.status < 600;
      const retryable = rateLimited || (serverError && idempotent);
      if (retryable && !lastAttempt) {
        await sleep(parseRetryAfterMs(res) ?? backoffDelayMs(attempt));
        continue;
      }
      throw new GoogleApiError(
        res.status,
        `Google API ${res.status} ${res.statusText}: ${body}`,
        body,
        parseRetryAfterMs(res),
      );
    }
    // DELETE answers 204 with an empty body, which res.json() would choke on.
    if (res.status === 204) {
      return null;
    }
    try {
      return await res.json();
    } catch (error) {
      // A successful write may already be committed when the response stream is
      // interrupted, so callers must reconcile rather than treat this as a known
      // pre-commit failure.
      throw new GoogleNetworkError(error);
    }
  }
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

/** The organizer or creator of an event. `self` is Google's own marker for
 * "this is the calendar the copy lives on" — authoritative, unlike an email. */
export type MappedPerson = {
  email?: string;
  displayName?: string;
  self?: boolean;
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
  /** Google's `transparency`: "opaque" (busy) | "transparent" (free). */
  transparency?: string;
  attendees?: MappedAttendee[];
  attendeesOmitted?: boolean;
  googleUpdatedMs: number;
  organizer?: MappedPerson;
  creator?: MappedPerson;
  /** Tri-state by design — see the note on the schema's googleEventValidator. */
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  locked?: boolean;
  eventType?: string;
  recurringEventId?: string;
  hangoutLink?: string;
  /** The primary video entry point Google exposes for any conference provider. */
  conferenceUrl?: string;
  conferenceName?: string;
  conferenceType?: string;
};

export type RawCalendarDateTime = {
  dateTime?: string;
  date?: string;
  /** IANA zone; required by Google for recurring timed events. */
  timeZone?: string;
};

/** Render an instant the way Google wants it for this kind of event. An all-day
 * event is date-only, and the caller is expected to have passed a UTC-midnight
 * instant (with an exclusive end); a timed one is an ISO instant plus the zone
 * that anchors it. Shared by every action that writes times. */
export function toGoogleTime(
  ms: number,
  allDay: boolean,
  timeZone?: string,
): RawCalendarDateTime {
  return allDay
    ? { date: new Date(ms).toISOString().slice(0, 10) }
    : { dateTime: new Date(ms).toISOString(), timeZone };
}
type RawPersonRef = {
  email?: string;
  displayName?: string;
  self?: boolean;
};

/** One attendee exactly as Google sends it. Kept structural (rather than
 * reusing MappedAttendee) because RSVP round-trips this shape back unchanged,
 * including the fields we don't store. */
export type RawAttendee = {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
  comment?: string;
  additionalGuests?: number;
  resource?: boolean;
};

type RawConferenceData = {
  entryPoints?: {
    entryPointType?: string;
    uri?: string;
  }[];
  conferenceSolution?: {
    key?: { type?: string };
    name?: string;
  };
};

export type RawEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  colorId?: string;
  visibility?: string;
  transparency?: string;
  updated?: string;
  start?: RawCalendarDateTime;
  end?: RawCalendarDateTime;
  attendees?: RawAttendee[];
  attendeesOmitted?: boolean;
  organizer?: RawPersonRef;
  creator?: RawPersonRef;
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  locked?: boolean;
  eventType?: string;
  /** Present on recurring masters; expanded instances only carry recurringEventId. */
  recurrence?: string[];
  recurringEventId?: string;
  /** The occurrence's position in its series before any per-instance move. */
  originalStartTime?: RawCalendarDateTime;
  hangoutLink?: string;
  conferenceData?: RawConferenceData;
};

export type RawCalendarPage = {
  events: RawEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

/** Drop a person Google sent as an empty object, so "absent" stays absent
 * rather than becoming a row of undefineds. */
function mapPerson(raw: RawPersonRef | undefined): MappedPerson | undefined {
  if (!raw) {
    return undefined;
  }
  if (raw.email === undefined && raw.displayName === undefined && raw.self === undefined) {
    return undefined;
  }
  return { email: raw.email, displayName: raw.displayName, self: raw.self };
}

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
  const conferenceVideo = raw.conferenceData?.entryPoints?.find(
    (entryPoint) => entryPoint.entryPointType === "video" && entryPoint.uri,
  );
  const conferenceUrl = conferenceVideo?.uri ?? raw.hangoutLink;
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
    transparency: raw.transparency,
    attendees: attendees && attendees.length > 0 ? attendees : undefined,
    attendeesOmitted: raw.attendeesOmitted,
    googleUpdatedMs: raw.updated ? new Date(raw.updated).getTime() : Date.now(),
    organizer: mapPerson(raw.organizer),
    creator: mapPerson(raw.creator),
    // Passed through untouched: an absent guest permission means Google's
    // default for that field, and the defaults differ. Coercing here would
    // erase the distinction. The domain permission model applies the defaults.
    guestsCanModify: raw.guestsCanModify,
    guestsCanInviteOthers: raw.guestsCanInviteOthers,
    guestsCanSeeOtherGuests: raw.guestsCanSeeOtherGuests,
    locked: raw.locked,
    eventType: raw.eventType,
    recurringEventId: raw.recurringEventId,
    hangoutLink: raw.hangoutLink,
    conferenceUrl,
    conferenceName:
      raw.conferenceData?.conferenceSolution?.name ??
      (raw.hangoutLink
        ? "Google Meet"
        : conferenceUrl
          ? "Video call"
          : undefined),
    conferenceType:
      raw.conferenceData?.conferenceSolution?.key?.type ??
      (raw.hangoutLink ? "hangoutsMeet" : undefined),
  };
}

async function fetchRawCalendarPage(
  accessToken: string,
  opts: {
    calendarId: string;
    syncToken?: string;
    pageToken?: string;
    timeMinMs?: number;
    timeMaxMs?: number;
  },
): Promise<RawCalendarPage> {
  const params = new URLSearchParams({
    singleEvents: "true",
    showDeleted: "true",
    maxResults: "250",
  });
  if (opts.pageToken) {
    params.set("pageToken", opts.pageToken);
  }
  if (opts.syncToken) {
    // syncToken cannot be combined with timeMin/timeMax.
    params.set("syncToken", opts.syncToken);
  } else {
    if (opts.timeMinMs !== undefined) {
      params.set("timeMin", new Date(opts.timeMinMs).toISOString());
    }
    if (opts.timeMaxMs !== undefined) {
      // Bounds recurrence expansion so an open-ended series doesn't yield an
      // unbounded initial sync (singleEvents=true expands every instance).
      params.set("timeMax", new Date(opts.timeMaxMs).toISOString());
    }
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
    events: data.items ?? [],
    nextPageToken: data.nextPageToken,
    nextSyncToken: data.nextSyncToken,
  };
}

/** Raw variant used by the provider adapter so recurrence-instance metadata is
 * not discarded. The existing mapped helper below retains its public behavior. */
export async function fetchCalendarRawPage(
  accessToken: string,
  opts: {
    calendarId: string;
    syncToken?: string;
    pageToken?: string;
    timeMinMs?: number;
    timeMaxMs?: number;
  },
): Promise<RawCalendarPage> {
  return await fetchRawCalendarPage(accessToken, opts);
}

export async function fetchCalendarPage(
  accessToken: string,
  opts: {
    calendarId: string;
    syncToken?: string;
    pageToken?: string;
    timeMinMs?: number;
    timeMaxMs?: number;
  },
): Promise<CalendarPage> {
  const page = await fetchRawCalendarPage(accessToken, opts);
  return {
    events: page.events.map((event) => mapGoogleEvent(event, opts.calendarId)),
    nextPageToken: page.nextPageToken,
    nextSyncToken: page.nextSyncToken,
  };
}

export type CalendarEventCreateBody = {
  /** Client-selected ID used to make retries idempotent. */
  id?: string;
  summary: string;
  description?: string;
  location?: string;
  start: RawCalendarDateTime;
  end: RawCalendarDateTime;
  colorId?: string;
  visibility?: string;
  /** "opaque" (busy) | "transparent" (free). Omitted = Google's default. */
  transparency?: string;
  attendees?: RawAttendee[];
  recurrence?: string[];
};

export async function insertRawCalendarEvent(
  accessToken: string,
  calendarId: string,
  body: CalendarEventCreateBody,
  /** When set, Google emails the affected guests (e.g. "all" for invitations). */
  sendUpdates?: "all" | "externalOnly" | "none",
  /** Ask Google to mint a Google Meet link for the event. The generated URL
   * comes back on the response as `hangoutLink`. */
  addConference?: boolean,
  conferenceRequestId?: string,
): Promise<RawEvent> {
  const params = new URLSearchParams();
  if (sendUpdates) params.set("sendUpdates", sendUpdates);
  // A `createRequest` only takes effect when this is set — without it Google
  // silently ignores the conference data and no Meet link is created.
  if (addConference) params.set("conferenceDataVersion", "1");
  // Avoid URLSearchParams.size — it's not available in every runtime, and a
  // wrong falsy read here would drop conferenceDataVersion and quietly skip
  // the Meet. toString() is empty when nothing was set.
  const qs = params.toString();
  const query = qs ? `?${qs}` : "";
  const requestBody = addConference
    ? { ...body, conferenceData: newMeetRequest(conferenceRequestId) }
    : body;
  return (await googleFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events${query}`,
    accessToken,
    { method: "POST", body: JSON.stringify(requestBody) },
  )) as RawEvent;
}

export async function insertCalendarEvent(
  accessToken: string,
  calendarId: string,
  body: CalendarEventCreateBody,
  sendUpdates?: "all" | "externalOnly" | "none",
  addConference?: boolean,
  conferenceRequestId?: string,
): Promise<MappedEvent> {
  return mapGoogleEvent(
    await insertRawCalendarEvent(
      accessToken,
      calendarId,
      body,
      sendUpdates,
      addConference,
      conferenceRequestId,
    ),
    calendarId,
  );
}

/** The `conferenceData` payload that asks Google to create a Google Meet. The
 * `requestId` dedupes retries — a repeated request with the same id returns the
 * existing conference rather than making a second one. */
function newMeetRequest(requestId: string = crypto.randomUUID()) {
  return {
    createRequest: {
      requestId,
      conferenceSolutionKey: { type: "hangoutsMeet" },
    },
  };
}

/** Read one event back from Google. RSVP needs this: patching `attendees`
 * replaces the array wholesale, so we must start from Google's own copy rather
 * than from the subset we store. */
export async function getCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
): Promise<RawEvent> {
  return (await googleFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
    accessToken,
  )) as RawEvent;
}

/** Delete an event. As its organizer this cancels it for every guest; as a mere
 * guest it removes only your copy and the organizer is not notified. On an
 * expanded instance id it removes just that occurrence. */
export async function deleteCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
  sendUpdates?: "all" | "externalOnly" | "none",
): Promise<void> {
  const query = sendUpdates ? `?sendUpdates=${sendUpdates}` : "";
  await googleFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}${query}`,
    accessToken,
    { method: "DELETE" },
  );
}

/** Patch an existing event's fields (e.g. a rescheduled start/end) and return
 * the re-mapped result. For a recurring series this targets a single expanded
 * instance by its `googleEventId`, so Google records a per-occurrence exception.
 *
 * A patch only touches the fields present in `body`. To *clear* a field you
 * must send an explicit `null` — omitting it means "leave alone", which is why
 * the clearable fields are typed `string | null` rather than optional strings. */
export type CalendarEventPatchBody = {
  start?: RawCalendarDateTime;
  end?: RawCalendarDateTime;
  summary?: string;
  description?: string | null;
  location?: string | null;
  colorId?: string | null;
  visibility?: string | null;
  transparency?: string;
  attendees?: RawAttendee[];
  recurrence?: string[];
};

export async function patchRawCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
  body: CalendarEventPatchBody,
  /** When set, Google emails the affected guests (e.g. "all" for invitations). */
  sendUpdates?: "all" | "externalOnly" | "none",
  /** `"add"` mints a Google Meet link, `"remove"` clears any existing one, and
   * `undefined` leaves the event's conferencing untouched. */
  conference?: "add" | "remove",
  conferenceRequestId?: string,
): Promise<RawEvent> {
  const params = new URLSearchParams();
  if (sendUpdates) params.set("sendUpdates", sendUpdates);
  if (conference) params.set("conferenceDataVersion", "1");
  // See insertCalendarEvent: don't rely on URLSearchParams.size.
  const qs = params.toString();
  const query = qs ? `?${qs}` : "";
  const requestBody =
    conference === "add"
      ? { ...body, conferenceData: newMeetRequest(conferenceRequestId) }
      : conference === "remove"
        ? { ...body, conferenceData: null }
        : body;
  return (await googleFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}${query}`,
    accessToken,
    { method: "PATCH", body: JSON.stringify(requestBody) },
  )) as RawEvent;
}

export async function patchCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
  body: CalendarEventPatchBody,
  sendUpdates?: "all" | "externalOnly" | "none",
  conference?: "add" | "remove",
  conferenceRequestId?: string,
): Promise<MappedEvent> {
  return mapGoogleEvent(
    await patchRawCalendarEvent(
      accessToken,
      calendarId,
      googleEventId,
      body,
      sendUpdates,
      conference,
      conferenceRequestId,
    ),
    calendarId,
  );
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

// "Other contacts" are addresses Google auto-collected from the user's activity
// (people they've emailed but never saved). Unlike `connections`, this endpoint
// takes `readMask` (not `personFields`) and only returns profile fields — notably
// photos — when `sources` includes READ_SOURCE_TYPE_PROFILE. We request both the
// contact and profile sources so people with a public Google photo carry one.
export async function fetchOtherContactsPage(
  accessToken: string,
  opts: { syncToken?: string; pageToken?: string; requestSyncToken?: boolean },
): Promise<ContactsPage> {
  const params = new URLSearchParams({
    readMask: "names,emailAddresses,phoneNumbers,photos",
    pageSize: "200",
  });
  params.append("sources", "READ_SOURCE_TYPE_CONTACT");
  params.append("sources", "READ_SOURCE_TYPE_PROFILE");
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
    `${PEOPLE_BASE}/otherContacts?${params.toString()}`,
    accessToken,
  )) as {
    otherContacts?: RawPerson[];
    nextPageToken?: string;
    nextSyncToken?: string;
  };

  return {
    contacts: (data.otherContacts ?? []).map(mapGoogleContact),
    nextPageToken: data.nextPageToken,
    nextSyncToken: data.nextSyncToken,
  };
}
