/**
 * Pure mappings between the Google REST shapes (`client.ts`) and the
 * provider-neutral port (`integrations/calendar`). No fetch, no ctx — just data
 * in, data out — so they unit-test without a network or a Convex runtime.
 */

import {
  GoogleApiError,
  GoogleNetworkError,
  SyncTokenExpiredError,
  type MappedCalendar,
  type MappedEvent,
  type RawCalendarDateTime,
  type RawEvent,
} from "./client";
import {
  ProviderError,
  type ProviderErrorKind,
} from "../calendar/errors";
import type {
  EventStatus,
  PageCursor,
  ProviderCalendar,
  ProviderEvent,
  SyncCursor,
} from "../calendar/types";

const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer"]);

export function toProviderCalendar(cal: MappedCalendar): ProviderCalendar {
  return {
    id: cal.googleCalendarId,
    summary: cal.summaryOverride ?? cal.summary,
    primary: cal.primary,
    timeZone: cal.timeZone,
    color: cal.backgroundColor,
    writable: WRITABLE_ACCESS_ROLES.has(cal.accessRole ?? ""),
    selected: cal.googleSelected,
  };
}

function normalizeStatus(status: string): EventStatus {
  return status === "cancelled" || status === "tentative"
    ? status
    : "confirmed";
}

function normalizeResponse(
  status: string | undefined,
): ("needsAction" | "accepted" | "tentative" | "declined") | undefined {
  return status === "accepted" ||
    status === "tentative" ||
    status === "declined" ||
    status === "needsAction"
    ? status
    : undefined;
}

function googleTimeMs(value: RawCalendarDateTime | undefined): number | undefined {
  const encoded = value?.dateTime ?? value?.date;
  if (!encoded) return undefined;
  const parsed = new Date(encoded).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function toProviderEvent(
  event: MappedEvent,
  raw?: Pick<RawEvent, "recurrence" | "originalStartTime" | "start">,
): ProviderEvent {
  const conference =
    event.conferenceUrl || event.conferenceName || event.conferenceType || event.hangoutLink
      ? {
          url: event.conferenceUrl ?? event.hangoutLink,
          name: event.conferenceName,
          type: event.conferenceType,
        }
      : undefined;

  return {
    id: event.googleEventId,
    calendarId: event.calendarId,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startMs: event.startMs,
    endMs: event.endMs,
    allDay: event.allDay,
    timeZone: raw?.start?.timeZone ?? raw?.originalStartTime?.timeZone,
    status: normalizeStatus(event.status),
    updatedMs: event.googleUpdatedMs,
    htmlLink: event.htmlLink,
    color: event.colorId,
    visibility: event.visibility,
    // Google omits transparency at its "busy" default; only "transparent" is a
    // deliberate "free". Undefined stays undefined so the domain keeps the
    // default rather than us inventing a value.
    busy:
      event.transparency === undefined
        ? undefined
        : event.transparency !== "transparent",
    attendees: event.attendees?.map((a) => ({
      email: a.email,
      displayName: a.displayName,
      self: a.self,
      responseStatus: normalizeResponse(a.responseStatus),
      organizer: a.organizer,
      optional: a.optional,
    })),
    attendeesOmitted: event.attendeesOmitted,
    organizer: event.organizer,
    creator: event.creator,
    guestsCanModify: event.guestsCanModify,
    guestsCanInviteOthers: event.guestsCanInviteOthers,
    guestsCanSeeOtherGuests: event.guestsCanSeeOtherGuests,
    locked: event.locked,
    eventType: event.eventType,
    recurrence: raw?.recurrence,
    seriesId: event.recurringEventId,
    originalOccurrenceStartMs: googleTimeMs(raw?.originalStartTime),
    conference,
  };
}

/**
 * Reverse of {@link toProviderEvent}: a neutral event back into the Google-shaped
 * `MappedEvent` the synced `events` table stores. Used at cutover so a write that
 * goes through the adapter (which returns a ProviderEvent) can still be mirrored
 * into the row shape the rest of the app reads. For Google the id round-trips
 * exactly (`id` is the `googleEventId`); the neutral `busy` flag becomes
 * `transparency`, and `conference` unfolds back into the flat conference fields.
 */
export function providerEventToMapped(event: ProviderEvent): MappedEvent {
  return {
    googleEventId: event.id,
    calendarId: event.calendarId,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startMs: event.startMs,
    endMs: event.endMs,
    allDay: event.allDay,
    status: event.status,
    htmlLink: event.htmlLink,
    colorId: event.color,
    visibility: event.visibility,
    transparency:
      event.busy === undefined ? undefined : event.busy ? "opaque" : "transparent",
    attendees: event.attendees
      ?.filter((a): a is typeof a & { email: string } => a.email !== undefined)
      .map((a) => ({
        email: a.email,
        displayName: a.displayName,
        responseStatus: a.responseStatus,
        organizer: a.organizer,
        self: a.self,
        optional: a.optional,
      })),
    attendeesOmitted: event.attendeesOmitted,
    googleUpdatedMs: event.updatedMs,
    organizer: event.organizer,
    creator: event.creator,
    guestsCanModify: event.guestsCanModify,
    guestsCanInviteOthers: event.guestsCanInviteOthers,
    guestsCanSeeOtherGuests: event.guestsCanSeeOtherGuests,
    locked: event.locked,
    eventType: event.eventType,
    recurringEventId: event.seriesId,
    hangoutLink:
      event.conference?.type === "hangoutsMeet" ? event.conference.url : undefined,
    conferenceUrl: event.conference?.url,
    conferenceName: event.conference?.name,
    conferenceType: event.conference?.type,
  };
}

// --- Opaque cursor codecs --------------------------------------------------

export function encodeSyncCursor(token: string): SyncCursor {
  return token as SyncCursor;
}

/** Accept raw persisted Google tokens and the JSON envelope emitted by the
 * first adapter draft, so connection backfills can be replayed directly. */
export function decodeSyncCursor(cursor: SyncCursor): string {
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "s" in parsed &&
      typeof parsed.s === "string"
    ) {
      return parsed.s;
    }
  } catch {
    // A legacy Google sync token is intentionally not JSON.
  }
  return cursor;
}

export function encodePageCursor(token: string): PageCursor {
  return token as PageCursor;
}

export function decodePageCursor(cursor: PageCursor): string {
  return cursor;
}

// --- Error classification --------------------------------------------------

export type GoogleCalendarOperation =
  | "read"
  | "sync"
  | "create"
  | "update"
  | "respond"
  | "delete";

function isUnsafeWrite(operation: GoogleCalendarOperation): boolean {
  return operation === "create" || operation === "update" || operation === "respond";
}

function classifyStatus(
  error: GoogleApiError,
  operation: GoogleCalendarOperation,
): ProviderErrorKind {
  const { status } = error;
  const rateLimitBody = error.responseBody ?? error.message;
  if (
    status === 429 ||
    (status === 403 && /(?:user)?rateLimitExceeded/i.test(rateLimitBody))
  ) {
    return "rate-limited";
  }
  if (status === 408) {
    return isUnsafeWrite(operation) ? "ambiguous" : "transient";
  }
  if (status >= 500) {
    return isUnsafeWrite(operation) ? "ambiguous" : "transient";
  }
  switch (status) {
    case 401:
      return "authentication";
    case 403:
      return "permission";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 410:
      return operation === "sync" ? "cursor-expired" : "not-found";
    case 400:
      return "validation";
    default:
      return "validation";
  }
}

/**
 * Fold a Google transport failure into the neutral taxonomy in the context of
 * the attempted operation. Read failures are transient; a lost response or 5xx
 * from an unsafe write is ambiguous because the write may have landed. An
 * expired token is `cursor-expired` only for sync.
 */
export function toProviderError(
  error: unknown,
  operation: GoogleCalendarOperation,
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof SyncTokenExpiredError) {
    return new ProviderError(
      operation === "sync" ? "cursor-expired" : "not-found",
      error.message,
      { cause: error },
    );
  }
  if (error instanceof GoogleNetworkError) {
    const kind = isUnsafeWrite(operation) ? "ambiguous" : "transient";
    return new ProviderError(kind, error.message, {
      retryable: kind === "transient",
      cause: error,
    });
  }
  if (error instanceof GoogleApiError) {
    const kind = classifyStatus(error, operation);
    return new ProviderError(kind, error.message, {
      retryable: kind === "transient" || kind === "rate-limited",
      retryAfterMs: error.retryAfterMs,
      cause: error,
    });
  }
  const kind = isUnsafeWrite(operation) ? "ambiguous" : "transient";
  return new ProviderError(
    kind,
    error instanceof Error ? error.message : String(error),
    { retryable: kind === "transient", cause: error },
  );
}
