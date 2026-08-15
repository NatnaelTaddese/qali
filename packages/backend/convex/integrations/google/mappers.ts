/**
 * Pure mappings between the Google REST shapes (`lib/google.ts`) and the
 * provider-neutral port (`integrations/calendar`). No fetch, no ctx — just data
 * in, data out — so they unit-test without a network or a Convex runtime.
 */

import {
  GoogleApiError,
  GoogleNetworkError,
  SyncTokenExpiredError,
  type MappedCalendar,
  type MappedEvent,
} from "../../lib/google";
import {
  ProviderError,
  type ProviderErrorKind,
} from "../calendar/errors";
import type {
  EventStatus,
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

export function toProviderEvent(event: MappedEvent): ProviderEvent {
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
    seriesId: event.recurringEventId,
    conference,
  };
}

// --- Opaque cursor codec ---------------------------------------------------
// Google exposes two distinct cursors — a `pageToken` that walks within one
// sync pass and a `syncToken` that deltas between passes. The port hides both
// behind one opaque string, so the adapter tags which it holds and the caller
// never has to know.

interface DecodedCursor {
  pageToken?: string;
  syncToken?: string;
}

export function encodeCursor(parts: DecodedCursor): SyncCursor {
  return JSON.stringify(
    parts.syncToken ? { s: parts.syncToken } : { p: parts.pageToken },
  );
}

export function decodeCursor(cursor: SyncCursor): DecodedCursor {
  const parsed = JSON.parse(cursor) as { p?: string; s?: string };
  return { pageToken: parsed.p, syncToken: parsed.s };
}

// --- Error classification --------------------------------------------------

function classifyStatus(status: number): ProviderErrorKind {
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
      return "cursor-expired";
    case 429:
      return "rate-limited";
    case 400:
      return "validation";
    default:
      return status >= 500 ? "transient" : "validation";
  }
}

/**
 * Fold any Google transport failure into the neutral taxonomy. A lost response
 * (`GoogleNetworkError`) is `ambiguous`, not `transient`: the write may have
 * landed, so the domain must reconcile by idempotency key rather than blindly
 * retry. An expired sync token is `cursor-expired`.
 */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof SyncTokenExpiredError) {
    return new ProviderError("cursor-expired", error.message, { cause: error });
  }
  if (error instanceof GoogleNetworkError) {
    return new ProviderError("ambiguous", error.message, {
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof GoogleApiError) {
    return new ProviderError(classifyStatus(error.status), error.message, {
      cause: error,
    });
  }
  return new ProviderError(
    "transient",
    error instanceof Error ? error.message : String(error),
    { retryable: true, cause: error },
  );
}
