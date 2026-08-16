/**
 * The Google implementation of the calendar port. It wraps the plain REST
 * helpers in `client.ts`, maps their shapes and failures into the neutral
 * contract, and is bound to a single access token — the domain never sees it.
 *
 * All Google-specific mechanics live here: the client-assigned event id that
 * makes a create idempotent, reading an event back to reconcile an ambiguous
 * create, and the read-then-patch RSVP dance (Google has no RSVP endpoint).
 * Swapping in Microsoft is writing a sibling of this file.
 */

import { googleEventIdForOperation } from "./eventHelpers";
import {
  deleteCalendarEvent,
  fetchCalendarList,
  fetchCalendarPage,
  getCalendarEvent,
  insertCalendarEvent,
  mapGoogleEvent,
  patchCalendarEvent,
  toGoogleTime,
  type RawAttendee,
} from "./client";
import { ProviderError } from "../calendar/errors";
import type {
  CalendarProviderAdapter,
  CreateEventRequest,
  EventRef,
  EventWrite,
  NotifyScope,
  ProviderCalendar,
  ProviderCapabilities,
  ProviderEvent,
  SyncCursor,
  SyncPage,
} from "../calendar/types";
import {
  decodeCursor,
  encodeCursor,
  toProviderCalendar,
  toProviderError,
  toProviderEvent,
} from "./mappers";

const GOOGLE_CAPABILITIES: ProviderCapabilities = {
  contacts: true,
  idempotentCreate: true,
};

/** Turn a neutral write into the timed start/end Google wants, if times are set. */
function writeTimes(write: EventWrite) {
  if (write.startMs === undefined || write.endMs === undefined) return {};
  const allDay = write.allDay ?? false;
  return {
    start: toGoogleTime(write.startMs, allDay, write.timeZone),
    end: toGoogleTime(write.endMs, allDay, write.timeZone),
  };
}

function transparencyFor(write: EventWrite): string | undefined {
  if (write.busy === undefined) return undefined;
  return write.busy ? "opaque" : "transparent";
}

export class GoogleCalendarAdapter implements CalendarProviderAdapter {
  readonly provider = "google" as const;
  readonly capabilities = GOOGLE_CAPABILITIES;

  constructor(private readonly accessToken: string) {}

  async listCalendars(): Promise<readonly ProviderCalendar[]> {
    try {
      const calendars = await fetchCalendarList(this.accessToken);
      return calendars.map(toProviderCalendar);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async listEvents(args: {
    calendarId: string;
    cursor: SyncCursor | null;
    fromMs: number;
    toMs: number;
  }): Promise<SyncPage<ProviderEvent>> {
    const decoded = args.cursor ? decodeCursor(args.cursor) : {};
    try {
      const page = await fetchCalendarPage(this.accessToken, {
        calendarId: args.calendarId,
        // Keep the pass anchor on every page: a delta pass carries its syncToken,
        // a full pass its window, alongside the pageToken continuation — matching
        // what Google (and the existing sync loop) require so the params stay
        // identical across a pass. syncToken forbids timeMin/timeMax.
        syncToken: decoded.syncToken,
        pageToken: decoded.pageToken,
        ...(decoded.syncToken
          ? {}
          : { timeMinMs: args.fromMs, timeMaxMs: args.toMs }),
      });
      return {
        items: page.events.map(toProviderEvent),
        nextPageCursor: page.nextPageToken
          ? encodeCursor({
              pageToken: page.nextPageToken,
              syncToken: decoded.syncToken,
            })
          : null,
        commitCursor: page.nextSyncToken
          ? encodeCursor({ syncToken: page.nextSyncToken })
          : null,
      };
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async getEvent(ref: EventRef): Promise<ProviderEvent> {
    try {
      const raw = await getCalendarEvent(
        this.accessToken,
        ref.calendarId,
        ref.eventId,
      );
      return toProviderEvent(mapGoogleEvent(raw, ref.calendarId));
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async createEvent(request: CreateEventRequest): Promise<ProviderEvent> {
    const { event, calendarId, idempotencyKey, notify } = request;
    if (event.startMs === undefined || event.endMs === undefined) {
      throw new ProviderError("validation", "createEvent requires start and end");
    }
    // The idempotency key becomes a client-assigned Google event id, so a retry
    // that already landed comes back as a 409 the domain reconciles rather than
    // a duplicate. Same key seeds the Meet requestId to dedupe conference creates.
    const id = idempotencyKey
      ? googleEventIdForOperation(idempotencyKey)
      : undefined;
    try {
      const created = await insertCalendarEvent(
        this.accessToken,
        calendarId,
        {
          id,
          summary: event.summary ?? "",
          description: event.description,
          location: event.location,
          ...(writeTimes(event) as {
            start: ReturnType<typeof toGoogleTime>;
            end: ReturnType<typeof toGoogleTime>;
          }),
          colorId: event.color,
          visibility: event.visibility,
          transparency: transparencyFor(event),
          attendees: event.attendees?.map((a) => ({ ...a })),
          recurrence: event.recurrence ? [...event.recurrence] : undefined,
        },
        notify,
        event.addConference,
        idempotencyKey,
      );
      return toProviderEvent(created);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async reconcileAmbiguousCreate(args: {
    calendarId: string;
    idempotencyKey: string;
  }): Promise<ProviderEvent | null> {
    try {
      const raw = await getCalendarEvent(
        this.accessToken,
        args.calendarId,
        googleEventIdForOperation(args.idempotencyKey),
      );
      return toProviderEvent(mapGoogleEvent(raw, args.calendarId));
    } catch (error) {
      const mapped = toProviderError(error);
      if (mapped.kind === "not-found") return null;
      throw mapped;
    }
  }

  async updateEvent(args: {
    ref: EventRef;
    patch: EventWrite;
    notify?: NotifyScope;
  }): Promise<ProviderEvent> {
    try {
      const patched = await patchCalendarEvent(
        this.accessToken,
        args.ref.calendarId,
        args.ref.eventId,
        {
          ...writeTimes(args.patch),
          summary: args.patch.summary,
          description: args.patch.description,
          location: args.patch.location,
          colorId: args.patch.color,
          visibility: args.patch.visibility,
          transparency: transparencyFor(args.patch),
          attendees: args.patch.attendees?.map((a) => ({ ...a })),
          recurrence: args.patch.recurrence
            ? [...args.patch.recurrence]
            : undefined,
        },
        args.notify,
      );
      return toProviderEvent(patched);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async respondToEvent(args: {
    ref: EventRef;
    responseStatus: "accepted" | "tentative" | "declined";
    notify?: NotifyScope;
  }): Promise<ProviderEvent> {
    try {
      // Google has no RSVP endpoint: read the live event, set only the self
      // attendee's status, and patch the (wholesale-replaced) attendee array.
      const live = await getCalendarEvent(
        this.accessToken,
        args.ref.calendarId,
        args.ref.eventId,
      );
      const attendees: RawAttendee[] = (live.attendees ?? []).map((a) =>
        a.self ? { ...a, responseStatus: args.responseStatus } : a,
      );
      const patched = await patchCalendarEvent(
        this.accessToken,
        args.ref.calendarId,
        args.ref.eventId,
        { attendees },
        args.notify,
      );
      return toProviderEvent(patched);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async deleteEvent(args: {
    ref: EventRef;
    notify?: NotifyScope;
  }): Promise<void> {
    try {
      await deleteCalendarEvent(
        this.accessToken,
        args.ref.calendarId,
        args.ref.eventId,
        args.notify,
      );
    } catch (error) {
      throw toProviderError(error);
    }
  }
}
