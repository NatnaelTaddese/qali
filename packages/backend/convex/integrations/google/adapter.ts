/** Google Calendar implementation of the provider-neutral calendar port. */

import {
  googleEventIdForOperation,
  googleEventMatchesPatch,
  mergeLiveAttendees,
} from "./eventHelpers";
import {
  deleteCalendarEvent,
  fetchCalendarList,
  fetchCalendarRawPage,
  getCalendarEvent,
  insertRawCalendarEvent,
  mapGoogleEvent,
  patchRawCalendarEvent,
  toGoogleTime,
  type CalendarEventPatchBody,
  type CalendarEventCreateBody,
  type RawEvent,
} from "./client";
import { ProviderError } from "../calendar/errors";
import type {
  CalendarProviderAdapter,
  CreateEventRequest,
  EventCreate,
  EventPatch,
  EventRef,
  PageCursor,
  ProviderCalendar,
  ProviderCapabilities,
  ProviderEvent,
  SyncCursor,
  SyncPage,
  UpdateEventRequest,
} from "../calendar/types";
import {
  decodePageCursor,
  decodeSyncCursor,
  encodePageCursor,
  encodeSyncCursor,
  toProviderCalendar,
  toProviderError,
  toProviderEvent,
} from "./mappers";

const GOOGLE_CAPABILITIES: ProviderCapabilities = {
  contacts: true,
  recurringEvents: true,
  attendeeMembershipUpdates: true,
  rsvp: true,
  removeSelf: true,
  conference: { create: true, add: true, remove: true },
  idempotentCreate: true,
  idempotentUpdate: true,
  idempotentResponse: true,
  idempotentDelete: true,
};

function providerEvent(raw: RawEvent, calendarId: string): ProviderEvent {
  return toProviderEvent(mapGoogleEvent(raw, calendarId), raw);
}

function validateTimePair(write: EventCreate | EventPatch, required: boolean): void {
  if ((write.startMs === undefined) !== (write.endMs === undefined)) {
    throw new ProviderError("validation", "Start and end must be provided together");
  }
  if (write.startMs === undefined || write.endMs === undefined) {
    if (required) throw new ProviderError("validation", "Start and end are required");
    return;
  }
  if (
    !Number.isFinite(write.startMs) ||
    !Number.isFinite(write.endMs) ||
    write.endMs <= write.startMs
  ) {
    throw new ProviderError("validation", "The event must end after it starts");
  }
}

function writeTimes(write: EventCreate | EventPatch) {
  if (write.startMs === undefined || write.endMs === undefined) return {};
  const allDay = write.allDay ?? false;
  return {
    start: toGoogleTime(write.startMs, allDay, write.timeZone),
    end: toGoogleTime(write.endMs, allDay, write.timeZone),
  };
}

function transparencyFor(write: EventCreate | EventPatch): string | undefined {
  if (write.busy === undefined) return undefined;
  return write.busy ? "opaque" : "transparent";
}

function conferenceChange(
  conference: EventPatch["conference"],
): "add" | "remove" | undefined {
  return conference === "add" || conference === "remove" ? conference : undefined;
}

function preserveConcurrentAttendees(
  live: NonNullable<RawEvent["attendees"]>,
  requested: { email: string; displayName?: string; optional?: boolean }[],
  knownAttendeeEmails: readonly string[] | undefined,
): void {
  if (!knownAttendeeEmails) return;
  const known = new Set(knownAttendeeEmails.map((email) => email.toLowerCase()));
  const desired = new Set(requested.map((attendee) => attendee.email.toLowerCase()));
  for (const attendee of live) {
    const email = attendee.email?.toLowerCase();
    if (email && !known.has(email) && !desired.has(email)) {
      requested.push({ email: attendee.email! });
      desired.add(email);
    }
  }
}

export class GoogleCalendarAdapter implements CalendarProviderAdapter {
  readonly provider = "google" as const;
  readonly capabilities = GOOGLE_CAPABILITIES;

  constructor(private readonly accessToken: string) {}

  private async readRaw(ref: EventRef): Promise<RawEvent> {
    try {
      return await getCalendarEvent(
        this.accessToken,
        ref.calendarId,
        ref.eventId,
      );
    } catch (error) {
      throw toProviderError(error, "read");
    }
  }

  async listCalendars(): Promise<readonly ProviderCalendar[]> {
    try {
      return (await fetchCalendarList(this.accessToken)).map(toProviderCalendar);
    } catch (error) {
      throw toProviderError(error, "read");
    }
  }

  async listEvents(args: {
    calendarId: string;
    syncCursor: SyncCursor | null;
    pageCursor?: PageCursor | null;
    fromMs: number;
    toMs: number;
  }): Promise<SyncPage<ProviderEvent>> {
    try {
      const syncToken = args.syncCursor
        ? decodeSyncCursor(args.syncCursor)
        : undefined;
      const page = await fetchCalendarRawPage(this.accessToken, {
        calendarId: args.calendarId,
        syncToken,
        pageToken: args.pageCursor
          ? decodePageCursor(args.pageCursor)
          : undefined,
        ...(syncToken
          ? {}
          : { timeMinMs: args.fromMs, timeMaxMs: args.toMs }),
      });
      return {
        items: page.events.map((event) => providerEvent(event, args.calendarId)),
        nextPageCursor: page.nextPageToken
          ? encodePageCursor(page.nextPageToken)
          : null,
        commitCursor: page.nextSyncToken
          ? encodeSyncCursor(page.nextSyncToken)
          : null,
      };
    } catch (error) {
      throw toProviderError(error, "sync");
    }
  }

  async getEvent(ref: EventRef): Promise<ProviderEvent> {
    return providerEvent(await this.readRaw(ref), ref.calendarId);
  }

  async createEvent(request: CreateEventRequest): Promise<ProviderEvent> {
    validateTimePair(request.event, true);
    const { event, calendarId, idempotencyKey } = request;
    const allDay = event.allDay ?? false;
    let attendees: RawEvent["attendees"] = event.attendees?.map((attendee) => ({
      ...attendee,
    }));
    if (request.attendeeSourceRef) {
      const source = await this.readRaw(request.attendeeSourceRef);
      if (source.attendeesOmitted) {
        throw new ProviderError(
          "validation",
          "The provider returned only part of the attendee list, so the series cannot be split safely",
        );
      }
      if (event.attendees === undefined) {
        attendees = source.attendees;
      } else {
        const requested = event.attendees.map((attendee) => ({ ...attendee }));
        preserveConcurrentAttendees(
          source.attendees ?? [],
          requested,
          request.knownAttendeeEmails,
        );
        attendees = mergeLiveAttendees(source.attendees ?? [], requested);
      }
    }
    attendees = attendees?.filter(
      (attendee): attendee is typeof attendee & { email: string } =>
        Boolean(attendee.email),
    );
    const body: CalendarEventCreateBody = {
      id: idempotencyKey
        ? googleEventIdForOperation(idempotencyKey)
        : undefined,
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: toGoogleTime(event.startMs, allDay, event.timeZone),
      end: toGoogleTime(event.endMs, allDay, event.timeZone),
      colorId: event.color,
      visibility: event.visibility,
      transparency: transparencyFor(event),
      attendees,
      recurrence: event.recurrence ? [...event.recurrence] : undefined,
    };
    try {
      const raw = await insertRawCalendarEvent(
        this.accessToken,
        calendarId,
        body,
        request.notify,
        event.conference === "add",
        idempotencyKey,
      );
      return providerEvent(raw, calendarId);
    } catch (error) {
      throw toProviderError(error, "create");
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
      return providerEvent(raw, args.calendarId);
    } catch (error) {
      const mapped = toProviderError(error, "read");
      if (mapped.kind === "not-found") return null;
      throw mapped;
    }
  }

  async updateEvent(request: UpdateEventRequest): Promise<ProviderEvent> {
    validateTimePair(request.patch, false);
    const { patch, ref } = request;
    let live: RawEvent | undefined;
    let attendees: RawEvent["attendees"];

    if (patch.attendees !== undefined || request.idempotencyKey !== undefined) {
      live = await this.readRaw(ref);
    }
    if (patch.attendees !== undefined) {
      if (live?.attendeesOmitted) {
        throw new ProviderError(
          "validation",
          "The provider returned only part of the attendee list, so membership cannot be replaced safely",
        );
      }
      const requested = patch.attendees.map((attendee) => ({ ...attendee }));
      preserveConcurrentAttendees(
        live?.attendees ?? [],
        requested,
        request.knownAttendeeEmails,
      );
      attendees = mergeLiveAttendees(live?.attendees ?? [], requested);
    }

    const googlePatch: CalendarEventPatchBody = {
      ...writeTimes(patch),
      summary: patch.summary,
      description: patch.description,
      location: patch.location,
      colorId: patch.color,
      visibility: patch.visibility,
      transparency: transparencyFor(patch),
      attendees,
      recurrence: patch.recurrence ? [...patch.recurrence] : undefined,
    };
    const conference = conferenceChange(patch.conference);

    if (
      request.idempotencyKey !== undefined &&
      live &&
      googleEventMatchesPatch(live, googlePatch, conference)
    ) {
      return providerEvent(live, ref.calendarId);
    }

    const liveUpdatedMs = live?.updated
      ? new Date(live.updated).getTime()
      : undefined;
    if (
      (patch.attendees !== undefined || patch.recurrence !== undefined) &&
      request.expectedUpdatedMs !== undefined &&
      liveUpdatedMs !== request.expectedUpdatedMs
    ) {
      throw new ProviderError(
        "conflict",
        "The event changed after this update was prepared",
      );
    }

    try {
      const raw = await patchRawCalendarEvent(
        this.accessToken,
        ref.calendarId,
        ref.eventId,
        googlePatch,
        request.notify,
        conference,
        request.idempotencyKey,
      );
      return providerEvent(raw, ref.calendarId);
    } catch (error) {
      throw toProviderError(error, "update");
    }
  }

  async respondToEvent(args: {
    ref: EventRef;
    responseStatus: "accepted" | "tentative" | "declined";
    notify?: "all" | "none";
    idempotencyKey?: string;
  }): Promise<ProviderEvent> {
    const live = await this.readRaw(args.ref);
    if (live.attendeesOmitted) {
      throw new ProviderError(
        "validation",
        "The provider returned only part of the attendee list, so RSVP is unsafe",
      );
    }
    const self = (live.attendees ?? []).find((attendee) => attendee.self);
    if (!self) {
      throw new ProviderError(
        "validation",
        "The event has no self attendee to respond as",
      );
    }
    if (self.responseStatus === args.responseStatus) {
      return providerEvent(live, args.ref.calendarId);
    }
    const attendees = (live.attendees ?? []).map((attendee) =>
      attendee.self
        ? { ...attendee, responseStatus: args.responseStatus }
        : attendee,
    );
    try {
      return providerEvent(
        await patchRawCalendarEvent(
          this.accessToken,
          args.ref.calendarId,
          args.ref.eventId,
          { attendees },
          args.notify,
        ),
        args.ref.calendarId,
      );
    } catch (error) {
      throw toProviderError(error, "respond");
    }
  }

  async deleteEvent(args: {
    ref: EventRef;
    mode: "cancel" | "remove-self";
    notify?: "all" | "none";
    idempotencyKey?: string;
  }): Promise<void> {
    try {
      await deleteCalendarEvent(
        this.accessToken,
        args.ref.calendarId,
        args.ref.eventId,
        args.mode === "remove-self" ? "none" : args.notify,
      );
    } catch (error) {
      const mapped = toProviderError(error, "delete");
      if (mapped.kind === "not-found") return;
      throw mapped;
    }
  }
}
