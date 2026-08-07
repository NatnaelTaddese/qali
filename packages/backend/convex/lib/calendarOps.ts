/**
 * The Google-facing half of every calendar write, lifted out of `calendar.ts`
 * so more than one caller can reach it.
 *
 * The public actions in `calendar.ts` are thin wrappers over these ops: resolve
 * the user, fetch a token, call the op. The assistant applies a *confirmed*
 * proposal through the same functions, so a change it makes and a change the
 * user makes by hand take an identical path into Google and into the mirrored
 * `events` table. Having the assistant call the actions instead would re-resolve
 * the user and re-fetch a token on every tool call, which is also the pattern
 * `convex/_generated/ai/guidelines.md` warns against.
 *
 * Unlike ./permissions.ts and ./availability.ts this module is not import-free —
 * it reaches the database and Google, and only runs inside an action.
 */

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { createAuth } from "../auth";
import { CALENDAR_HISTORY_MS, syncOneCalendar } from "../googleSync";
import {
  deleteCalendarEvent,
  getCalendarEvent,
  GoogleApiError,
  insertCalendarEvent,
  mapGoogleEvent,
  type MappedEvent,
  patchCalendarEvent,
  type RawAttendee,
  type RawCalendarDateTime,
  type RawEvent,
  toGoogleTime,
} from "./google";
import {
  googleEventIdForOperation,
  mergeLiveAttendees,
  shiftRecurringMasterRange,
} from "./assistantLogic";
import { eventCapabilities, type EventCapabilities } from "./permissions";

export type EventCapabilityName =
  | "canEdit"
  | "canRespond"
  | "canDelete"
  | "canRemoveSelf";

const CAPABILITY_DENIAL: Record<EventCapabilityName, string> = {
  canEdit: "You can't edit this event",
  canRespond: "You're not a guest on this event",
  canDelete: "You can't delete this event",
  canRemoveSelf: "You can't remove this event",
};

/** Google has committed the write, but a local mirror/reconciliation write did
 * not. Callers must report external success rather than inviting a duplicate. */
export class ExternalWriteCommittedError extends Error {
  constructor(readonly successSummary: string, cause: unknown) {
    super(
      `Google accepted the change, but local reconciliation is pending: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ExternalWriteCommittedError";
  }
}

function validateTimePair(
  startMs: number | undefined,
  endMs: number | undefined,
  required: boolean,
): boolean {
  if ((startMs === undefined) !== (endMs === undefined)) {
    throw new Error("Start and end must be provided together");
  }
  if (startMs === undefined || endMs === undefined) {
    if (required) throw new Error("Start and end are required");
    return false;
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("The event must end after it starts");
  }
  return true;
}

export function isDefinitiveGoogleFailure(error: unknown): boolean {
  return (
    error instanceof GoogleApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

async function mirrorEvent(
  ctx: ActionCtx,
  userId: string,
  event: MappedEvent,
  successSummary: string,
): Promise<void> {
  try {
    await ctx.runMutation(internal.calendar.upsertEvent, { userId, event });
  } catch (error) {
    throw new ExternalWriteCommittedError(successSummary, error);
  }
}

type GoogleEventPatch = {
  summary?: string;
  description?: string | null;
  location?: string | null;
  colorId?: string | null;
  visibility?: string | null;
  transparency?: string;
  attendees?: RawAttendee[];
  start?: RawCalendarDateTime;
  end?: RawCalendarDateTime;
};

function sameGoogleTime(
  actual: RawCalendarDateTime | undefined,
  expected: RawCalendarDateTime | undefined,
): boolean {
  if (!expected) return true;
  if (expected.date !== undefined) return actual?.date === expected.date;
  if (expected.dateTime === undefined || actual?.dateTime === undefined) {
    return false;
  }
  return new Date(actual.dateTime).getTime() === new Date(expected.dateTime).getTime();
}

function attendeeKeys(attendees: RawAttendee[] | undefined): string[] {
  return (attendees ?? [])
    .flatMap((attendee) =>
      attendee.email
        ? [`${attendee.email.toLowerCase()}:${attendee.optional === true ? "optional" : "required"}`]
        : [],
    )
    .sort();
}

/** A retry after a lost Google response first checks whether the requested
 * patch is already visible. This is particularly important for guest edits:
 * repeating an already-applied PATCH with sendUpdates=all can email everyone
 * again even though the payload is otherwise idempotent. */
function googleEventMatchesPatch(
  event: RawEvent,
  patch: GoogleEventPatch,
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

/** A Google OAuth access token for `userId`, or a thrown error. Better Auth's
 * component owns the refresh, so this is always fetched at use time. */
export async function getGoogleAccessToken(
  ctx: ActionCtx,
  userId: string,
): Promise<string> {
  const { accessToken } = await createAuth(ctx).api.getAccessToken({
    body: { providerId: "google", userId },
  });
  if (!accessToken) {
    throw new Error("No Google access token available for user");
  }
  return accessToken;
}

/**
 * Load an event with its calendar and check that at least one of `allowed`
 * holds.
 *
 * Owning the row is not the same as being allowed to change it — sync copies
 * every calendar the user can *see*, holidays and read-only shares included —
 * so the capability check is the real gate here and Google's 403 is only a
 * backstop. Without it a refusal arrives after the optimistic UI has moved.
 *
 * Exported because the assistant runs this *before* proposing a write, so it
 * declines to offer an edit that could never be applied rather than showing the
 * user a confirm button that is guaranteed to fail.
 */
export async function resolveEventForWrite(
  ctx: ActionCtx,
  userId: string,
  eventId: Id<"events">,
  allowed: EventCapabilityName[],
): Promise<{ row: Doc<"events">; capabilities: EventCapabilities }> {
  const context = await ctx.runQuery(internal.calendar.getEventContext, {
    eventId,
    userId,
  });
  if (!context) {
    throw new Error("Event not found");
  }

  const capabilities = eventCapabilities(
    context.event,
    context.calendar ?? undefined,
  );
  if (!allowed.some((name) => capabilities[name])) {
    // `readOnlyReason` explains why the event can't be *edited*, so it is only
    // the right answer when editing is what was refused.
    throw new Error(
      allowed[0] === "canEdit" && capabilities.readOnlyReason
        ? capabilities.readOnlyReason
        : CAPABILITY_DENIAL[allowed[0]],
    );
  }

  return { row: context.event, capabilities };
}

/**
 * Pull a calendar's events in again after a change Google stores on a hidden
 * recurring master (create/split/series-edit). We sync with singleEvents=true,
 * so the master is never a row of ours — only its *expanded* instances are, and
 * the way to reflect a master change is to re-expand. Reused by `createEventOp`
 * and the series-wide branches of `updateEventOp`; a no-op if the calendar
 * hasn't synced yet.
 */
export async function resyncCalendar(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
  calendarId: string,
): Promise<void> {
  const calendars = await ctx.runQuery(
    internal.googleSync.listCalendarsForUser,
    { userId },
  );
  const cal = calendars.find((c) => c.googleCalendarId === calendarId);
  if (cal) {
    await syncOneCalendar(
      ctx,
      userId,
      accessToken,
      cal,
      Date.now() - CALENDAR_HISTORY_MS,
    );
  }
}

/** Format a UTC instant as an RFC5545 UNTIL value. A timed series uses the
 * date-time form; an all-day series uses the bare date form, matching the value
 * type of its DTSTART (mixing the two makes Google reject the rule). */
function toRRuleUntil(ms: number, allDay: boolean): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  return allDay
    ? day
    : `${day}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * Truncate a recurring master's rule so its last occurrence falls before
 * `untilMs`. Rewrites each `RRULE:` line to end on a fresh `UNTIL`, dropping any
 * `COUNT` or existing `UNTIL`; other recurrence lines (EXDATE/RDATE) pass
 * through untouched. This is how "this and following" ends the original series.
 */
function truncateRecurrence(
  recurrence: string[],
  untilMs: number,
  allDay: boolean,
): string[] {
  const until = toRRuleUntil(untilMs, allDay);
  return recurrence.map((line) => {
    if (!line.startsWith("RRULE:")) return line;
    const parts = line
      .slice("RRULE:".length)
      .split(";")
      .filter((part) => part && !/^(COUNT|UNTIL)=/.test(part));
    parts.push(`UNTIL=${until}`);
    return `RRULE:${parts.join(";")}`;
  });
}

export interface CreateEventArgs {
  summary: string;
  startMs: number;
  endMs: number;
  description?: string;
  location?: string;
  allDay?: boolean;
  calendarId?: string;
  colorId?: string;
  visibility?: string;
  transparency?: string;
  recurrence?: string[];
  attendees?: { email: string; displayName?: string }[];
  timeZone?: string;
  addConference?: boolean;
  /** Stable across confirmation retries. */
  operationId?: string;
}

/** Create a calendar event in Google, then mirror it into the synced table. */
export async function createEventOp(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
  args: CreateEventArgs,
): Promise<MappedEvent> {
  validateTimePair(args.startMs, args.endMs, true);
  // Write to (and stamp the mirrored row with) a real calendar id, so the
  // optimistic row matches what the next sync produces. Without an explicit
  // choice that's the user's primary, falling back to the "primary" keyword
  // if the calendar list hasn't synced yet.
  const targetCalendarId: string =
    args.calendarId ??
    (await ctx.runQuery(internal.calendar.getPrimaryCalendarId, { userId })) ??
    "primary";

  const allDay = args.allDay ?? false;
  const hasGuests = Boolean(args.attendees && args.attendees.length > 0);
  const requestedId = args.operationId
    ? googleEventIdForOperation(args.operationId)
    : undefined;
  let event: MappedEvent;
  try {
    event = await insertCalendarEvent(
      accessToken,
      targetCalendarId,
      {
        id: requestedId,
        summary: args.summary,
        description: args.description,
        location: args.location,
        start: toGoogleTime(args.startMs, allDay, args.timeZone),
        end: toGoogleTime(args.endMs, allDay, args.timeZone),
        colorId: args.colorId,
        visibility: args.visibility,
        transparency: args.transparency,
        attendees: args.attendees,
        recurrence: args.recurrence,
      },
      // Only ask Google to email invitations when there are actually guests.
      hasGuests ? "all" : undefined,
      args.addConference,
      args.operationId,
    );
  } catch (error) {
    // A previous attempt may have succeeded but lost its response. Google's
    // duplicate-ID 409 is then positive confirmation, not a failed create.
    if (!(error instanceof GoogleApiError) || error.status !== 409 || !requestedId) {
      throw error;
    }
    event = mapGoogleEvent(
      await getCalendarEvent(accessToken, targetCalendarId, requestedId),
      targetCalendarId,
    );
  }

  if (args.recurrence && args.recurrence.length > 0) {
    try {
      await ctx.runMutation(internal.calendar.upsertRecurringSeries, {
        userId,
        calendarId: targetCalendarId,
        googleEventId: event.googleEventId,
        recurrence: args.recurrence,
        sourceUpdatedMs: event.googleUpdatedMs,
      });
      // A recurring event is stored by Google as a hidden "master"; our sync
      // reads with singleEvents=true, so it only ever sees the *expanded*
      // instances (each a distinct googleEventId), never the master. Mirroring
      // `event` (the master) would leave an orphan row that no later sync
      // touches. Instead pull the freshly expanded instances in now.
      await resyncCalendar(ctx, userId, accessToken, targetCalendarId);
    } catch (error) {
      throw new ExternalWriteCommittedError(`Created “${args.summary}”.`, error);
    }
    return event;
  }

  await mirrorEvent(ctx, userId, event, `Created “${args.summary}”.`);
  return event;
}

export interface UpdateEventTimeArgs {
  eventId: Id<"events">;
  startMs: number;
  endMs: number;
  timeZone?: string;
  operationId?: string;
}

/** Reschedule an existing event: patch Google, then mirror the new times
 * locally. The frontend calls this on drag/resize; it holds an optimistic
 * override until this returns and the next sync reflects the change. */
export async function updateEventTimeOp(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
  args: UpdateEventTimeArgs,
): Promise<MappedEvent> {
  validateTimePair(args.startMs, args.endMs, true);
  const { row } = await resolveEventForWrite(ctx, userId, args.eventId, [
    "canEdit",
  ]);

  const event = await patchCalendarEvent(
    accessToken,
    row.calendarId,
    row.googleEventId,
    {
      start: toGoogleTime(args.startMs, row.allDay, args.timeZone),
      end: toGoogleTime(args.endMs, row.allDay, args.timeZone),
    },
  );

  await mirrorEvent(ctx, userId, event, "Event rescheduled.");
  return event;
}

export type UpdateEventScope = "thisEvent" | "thisAndFollowing" | "allEvents";

export interface UpdateEventArgs {
  eventId: Id<"events">;
  summary?: string;
  description?: string | null;
  location?: string | null;
  colorId?: string | null;
  visibility?: string | null;
  transparency?: string;
  startMs?: number;
  endMs?: number;
  allDay?: boolean;
  attendees?: RawAttendee[];
  timeZone?: string;
  conference?: "meet" | null;
  scope?: UpdateEventScope;
  operationId?: string;
  /** Refuse a delayed guest-list proposal if the synced event changed since the
   * user saw it. This avoids applying stale membership intent. */
  expectedGoogleUpdatedMs?: number;
  expectedSeriesUpdatedMs?: number;
}

/**
 * Edit an existing event: patch Google, then mirror the result locally.
 *
 * Every field is optional and only the ones present are sent, so a caller can
 * patch exactly what the user touched. Fields that can be *emptied* take an
 * explicit `null` for that, because Google reads an omitted field as "leave
 * alone" — sending `""` would store an empty string rather than clear it.
 *
 * For a recurring event, `scope` chooses how far the edit reaches. We sync with
 * singleEvents=true, so the row is always one expanded instance and each scope
 * maps to a different Google operation:
 *   - `thisEvent` — patch the instance id (a per-occurrence exception). The
 *     default, and the only path a non-recurring event can take.
 *   - `allEvents` — patch the recurring master (`recurringEventId`). A time
 *     change shifts the master by the same delta so every occurrence moves
 *     together rather than the series re-anchoring onto this date.
 *   - `thisAndFollowing` — Google has no endpoint for this. Split the series:
 *     end the original master on an `UNTIL` just before this occurrence, then
 *     create a fresh series from here carrying the edited + inherited fields.
 * The series-wide scopes re-expand by re-syncing the calendar, since the master
 * itself is never a row of ours.
 */
export async function updateEventOp(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
  args: UpdateEventArgs,
): Promise<MappedEvent> {
  const hasTimeChange = validateTimePair(args.startMs, args.endMs, false);
  const { row, capabilities } = await resolveEventForWrite(ctx, userId, args.eventId, [
    "canEdit",
  ]);

  // A non-recurring event has no series, so any scope collapses to the one
  // event; only a recurring instance can reach the master.
  const scope = row.recurringEventId ? (args.scope ?? "thisEvent") : "thisEvent";

  // Falling back to the stored value keeps a times-only patch rendering the
  // same kind of event it already was.
  const allDay = args.allDay ?? row.allDay;
  let attendees = args.attendees;
  let liveAttendeeSource: RawEvent | undefined;
  let liveAttendeeSourceChanged = false;
  if (attendees) {
    if (!capabilities.canInviteOthers) {
      throw new Error("The organiser does not allow you to invite or remove guests");
    }
    const attendeeSourceId =
      scope === "thisEvent" ? row.googleEventId : row.recurringEventId;
    if (!attendeeSourceId) throw new Error("Recurring series not found");
    const live = await getCalendarEvent(
      accessToken,
      row.calendarId,
      attendeeSourceId,
    );
    liveAttendeeSource = live;
    const liveUpdatedMs = live.updated ? new Date(live.updated).getTime() : undefined;
    liveAttendeeSourceChanged =
      scope === "thisEvent" &&
      args.expectedGoogleUpdatedMs !== undefined &&
      liveUpdatedMs !== undefined &&
      liveUpdatedMs !== args.expectedGoogleUpdatedMs;
    if (live.attendeesOmitted) {
      throw new Error(
        "Google returned only part of the guest list, so it is unsafe to replace it",
      );
    }
    const requested = attendees.filter(
      (attendee): attendee is RawAttendee & { email: string } =>
        Boolean(attendee.email),
    );
    const knownEmails = new Set(
      (row.attendees ?? []).map((attendee) => attendee.email.toLowerCase()),
    );
    const requestedEmails = new Set(
      requested.map((attendee) => attendee.email.toLowerCase()),
    );
    // If Google is ahead of our sync, preserve guests the proposal could not
    // possibly have intended to remove. A refreshed local row instead trips
    // expectedGoogleUpdatedMs above and asks for a fresh proposal.
    for (const attendee of live.attendees ?? []) {
      const email = attendee.email?.toLowerCase();
      if (email && !knownEmails.has(email) && !requestedEmails.has(email)) {
        requested.push({ email: attendee.email! });
        requestedEmails.add(email);
      }
    }
    attendees = mergeLiveAttendees(live.attendees ?? [], requested);
  }

  // The field patch shared by the instance and master paths. Times are added
  // per-path: the instance takes the edited instant directly, the master
  // takes the same *delta* so the whole series shifts together.
  const fields = {
    summary: args.summary,
    description: args.description,
    location: args.location,
    colorId: args.colorId,
    visibility: args.visibility,
    transparency: args.transparency,
    attendees,
  };
  // Only bother the guests when the guest list itself changed.
  const sendUpdates = args.attendees ? ("all" as const) : undefined;
  // undefined = leave conferencing alone; "meet" adds, null removes.
  const conference =
    args.conference === undefined
      ? undefined
      : args.conference === null
        ? "remove"
        : "add";

  if (scope === "thisEvent") {
    const times =
      hasTimeChange && args.startMs !== undefined && args.endMs !== undefined
        ? {
            start: toGoogleTime(args.startMs, allDay, args.timeZone),
            end: toGoogleTime(args.endMs, allDay, args.timeZone),
          }
        : {};
    const patch = { ...times, ...fields };
    if (args.operationId) {
      const live =
        liveAttendeeSource ??
        (await getCalendarEvent(accessToken, row.calendarId, row.googleEventId));
      if (googleEventMatchesPatch(live, patch, conference)) {
        const event = mapGoogleEvent(live, row.calendarId);
        await mirrorEvent(ctx, userId, event, "Event updated.");
        return event;
      }
    }
    if (
      args.attendees &&
      args.expectedGoogleUpdatedMs !== undefined &&
      (row.googleUpdatedMs !== args.expectedGoogleUpdatedMs ||
        liveAttendeeSourceChanged)
    ) {
      throw new Error(
        "The event changed after this guest-list proposal was made. Please propose it again.",
      );
    }
    const event = await patchCalendarEvent(
      accessToken,
      row.calendarId,
      row.googleEventId,
      patch,
      sendUpdates,
      conference,
      args.operationId,
    );
    await mirrorEvent(ctx, userId, event, "Event updated.");
    return event;
  }

  // Series-wide scopes need the master, both for its recurrence rule and (for
  // a time change) for the absolute times we shift by the instance's delta.
  const masterId = row.recurringEventId;
  if (!masterId) {
    throw new Error("Event is not part of a recurring series");
  }
  const rawMaster =
    liveAttendeeSource?.id === masterId
      ? liveAttendeeSource
      : await getCalendarEvent(accessToken, row.calendarId, masterId);
  const master = mapGoogleEvent(rawMaster, row.calendarId);
  const liveMasterUpdatedMs = rawMaster.updated
    ? new Date(rawMaster.updated).getTime()
    : undefined;
  const liveMasterChanged =
    args.attendees !== undefined &&
    args.expectedSeriesUpdatedMs !== undefined &&
    liveMasterUpdatedMs !== undefined &&
    liveMasterUpdatedMs !== args.expectedSeriesUpdatedMs;

  // Google requires a time zone on a recurring event's start/end. The client
  // only sends one when the times change, so fall back to the master series'
  // own stored zone — the correct anchor for any occurrence of the series.
  const effectiveTimeZone = args.timeZone ?? rawMaster.start?.timeZone;

  // Shift the master's own start/end by the delta the user applied to this
  // instance, so every occurrence moves by the same amount.
  let shiftedTimes: {
    start?: RawCalendarDateTime;
    end?: RawCalendarDateTime;
  } = {};
  if (hasTimeChange && args.startMs !== undefined && args.endMs !== undefined) {
    const shifted = shiftRecurringMasterRange({
      occurrenceStartMs: row.startMs,
      occurrenceEndMs: row.endMs,
      occurrenceAllDay: row.allDay,
      masterStartMs: master.startMs,
      masterEndMs: master.endMs,
      masterAllDay: master.allDay,
      targetStartMs: args.startMs,
      targetEndMs: args.endMs,
      targetAllDay: allDay,
      timeZone: effectiveTimeZone,
    });
    shiftedTimes = {
      start: toGoogleTime(shifted.startMs, allDay, effectiveTimeZone),
      end: toGoogleTime(shifted.endMs, allDay, effectiveTimeZone),
    };
  }

  // "This and following" from the very first occurrence has nothing before it
  // to keep, so it is just "all events" — patch the master rather than split
  // the series into an empty original.
  const isSeriesHead = row.startMs === master.startMs;

  if (scope === "allEvents" || isSeriesHead) {
    const patch = { ...shiftedTimes, ...fields };
    if (args.operationId && googleEventMatchesPatch(rawMaster, patch, conference)) {
      const updatedMaster = mapGoogleEvent(rawMaster, row.calendarId);
      await resyncCalendar(ctx, userId, accessToken, row.calendarId);
      return updatedMaster;
    }
    if (
      args.attendees &&
      args.expectedGoogleUpdatedMs !== undefined &&
      (row.googleUpdatedMs !== args.expectedGoogleUpdatedMs || liveMasterChanged)
    ) {
      throw new Error(
        "The event changed after this guest-list proposal was made. Please propose it again.",
      );
    }
    const updatedMaster = await patchCalendarEvent(
      accessToken,
      row.calendarId,
      masterId,
      patch,
      sendUpdates,
      conference,
      args.operationId,
    );
    try {
      await resyncCalendar(ctx, userId, accessToken, row.calendarId);
    } catch (error) {
      throw new ExternalWriteCommittedError("Event updated.", error);
    }
    return updatedMaster;
  }

  // scope === "thisAndFollowing", on a mid-series occurrence: split.
  //
  // End the original series just before this occurrence. NOTE: a COUNT=N rule
  // is reset to an UNTIL, while the tail keeps its original COUNT rather than
  // N-minus-elapsed. Only counting expanded occurrences could fix that
  // over-count; UNTIL and open-ended rules (the common cases) split exactly.
  const truncated = truncateRecurrence(
    rawMaster.recurrence ?? [],
    row.startMs - 1000,
    row.allDay,
  );
  const masterAlreadyTruncated =
    JSON.stringify(rawMaster.recurrence ?? []) === JSON.stringify(truncated);
  if (
    !masterAlreadyTruncated &&
    args.attendees &&
    args.expectedGoogleUpdatedMs !== undefined &&
    (row.googleUpdatedMs !== args.expectedGoogleUpdatedMs || liveMasterChanged)
  ) {
    throw new Error(
      "The event changed after this guest-list proposal was made. Please propose it again.",
    );
  }
  // Create the retry-safe tail first. If truncating the original then needs a
  // retry, the fixed ID recovers this exact series without emailing twice.
  // Each field is the edit if touched, otherwise the instance value carried
  // across; an explicitly cleared field is dropped rather than carried.
  const carried = <T>(edited: T | null | undefined, current: T | undefined) =>
    edited === undefined ? current : (edited ?? undefined);
  const newStartMs =
    hasTimeChange && args.startMs !== undefined ? args.startMs : row.startMs;
  const newEndMs =
    hasTimeChange && args.endMs !== undefined ? args.endMs : row.endMs;
  if (rawMaster.attendeesOmitted && attendees === undefined) {
    throw new Error(
      "Google returned only part of the guest list, so it is unsafe to split this series",
    );
  }
  const tailAttendees = (attendees ?? rawMaster.attendees)?.filter(
    (attendee): attendee is RawAttendee & { email: string } =>
      Boolean(attendee.email),
  );
  // Keep an existing Meet on the tail unless the edit removed it; mint one if
  // the edit added it. The new series gets its own link, not the original's.
  const addConference =
    args.conference === null
      ? false
      : args.conference === "meet"
        ? true
        : Boolean(row.hangoutLink);

  let requestedId = args.operationId
    ? googleEventIdForOperation(`${args.operationId}tail`)
    : undefined;
  let tailRecurrence = rawMaster.recurrence ?? [];
  let newSeries: MappedEvent | undefined;
  try {
    newSeries = await insertCalendarEvent(
      accessToken,
      row.calendarId,
      {
        id: requestedId,
        summary: args.summary ?? row.summary ?? "(No title)",
        description: carried(args.description, row.description),
        location: carried(args.location, row.location),
        start: toGoogleTime(newStartMs, allDay, effectiveTimeZone),
        end: toGoogleTime(newEndMs, allDay, effectiveTimeZone),
        colorId: carried(args.colorId, row.colorId),
        visibility: carried(args.visibility, row.visibility),
        transparency: args.transparency ?? row.transparency,
        attendees: tailAttendees,
        recurrence: tailRecurrence,
      },
      tailAttendees && tailAttendees.length > 0 ? "all" : undefined,
      addConference,
      args.operationId,
    );
  } catch (error) {
    if (!(error instanceof GoogleApiError) || error.status !== 409 || !requestedId) {
      throw error;
    }
    let existingTail: RawEvent | undefined = await getCalendarEvent(
      accessToken,
      row.calendarId,
      requestedId,
    );
    if (existingTail.status === "cancelled" && args.operationId) {
      // A prior definitive failure compensated by deleting its tail. Google
      // retains that ID as a tombstone, so only this confirmed-cancelled case
      // advances to a second stable ID. Every later retry probes this same ID,
      // so a lost response cannot create multiple replacement tails.
      requestedId = googleEventIdForOperation(
        `${args.operationId}tailretry`,
      );
      try {
        newSeries = await insertCalendarEvent(
          accessToken,
          row.calendarId,
          {
            id: requestedId,
            summary: args.summary ?? row.summary ?? "(No title)",
            description: carried(args.description, row.description),
            location: carried(args.location, row.location),
            start: toGoogleTime(newStartMs, allDay, effectiveTimeZone),
            end: toGoogleTime(newEndMs, allDay, effectiveTimeZone),
            colorId: carried(args.colorId, row.colorId),
            visibility: carried(args.visibility, row.visibility),
            transparency: args.transparency ?? row.transparency,
            attendees: tailAttendees,
            recurrence: tailRecurrence,
          },
          tailAttendees && tailAttendees.length > 0 ? "all" : undefined,
          addConference,
          args.operationId,
        );
        existingTail = undefined;
      } catch (retryError) {
        if (
          !(retryError instanceof GoogleApiError) ||
          retryError.status !== 409
        ) {
          throw retryError;
        }
        existingTail = await getCalendarEvent(
          accessToken,
          row.calendarId,
          requestedId,
        );
        if (existingTail.status === "cancelled") {
          throw new GoogleApiError(
            410,
            "The replacement series was cancelled; propose the split again",
          );
        }
      }
    }
    if (existingTail) {
      tailRecurrence = existingTail.recurrence ?? [];
      newSeries = mapGoogleEvent(existingTail, row.calendarId);
    }
  }
  if (!newSeries) {
    throw new Error("Could not create or recover the replacement series");
  }

  // Now end the original. Google has no transaction spanning these two series,
  // but retries can reconcile either side without creating another tail.
  let truncatedMaster = master;
  if (!masterAlreadyTruncated) {
    try {
      truncatedMaster = await patchCalendarEvent(
        accessToken,
        row.calendarId,
        masterId,
        { recurrence: truncated },
      );
    } catch (error) {
      if (isDefinitiveGoogleFailure(error)) {
        // The tail was created first for retry safety. If Google definitively
        // refuses to truncate the original, compensate immediately rather than
        // leave two active series behind.
        await deleteCalendarEvent(
          accessToken,
          row.calendarId,
          newSeries.googleEventId,
          tailAttendees && tailAttendees.length > 0 ? "all" : "none",
        );
      }
      throw error;
    }
  }
  try {
    await ctx.runMutation(internal.calendar.upsertRecurringSeries, {
      userId,
      calendarId: row.calendarId,
      googleEventId: masterId,
      recurrence: truncated,
      sourceUpdatedMs: truncatedMaster.googleUpdatedMs,
    });
    await ctx.runMutation(internal.calendar.upsertRecurringSeries, {
      userId,
      calendarId: row.calendarId,
      googleEventId: newSeries.googleEventId,
      recurrence: tailRecurrence,
      sourceUpdatedMs: newSeries.googleUpdatedMs,
    });

    // Re-expand both the truncated original and the new series into rows.
    await resyncCalendar(ctx, userId, accessToken, row.calendarId);
  } catch (error) {
    throw new ExternalWriteCommittedError("Event series updated.", error);
  }
  return newSeries;
}

export interface RespondToEventArgs {
  eventId: Id<"events">;
  responseStatus: "accepted" | "tentative" | "declined";
}

/**
 * Answer an invitation.
 *
 * Google has no RSVP endpoint — you patch the event's `attendees`, and a patch
 * *replaces* that array wholesale. So this reads Google's own copy first rather
 * than rebuilding the list from our rows: we store a subset of each attendee,
 * and sending that subset back would strip comments, extra guests and room
 * resources from the event for everyone on it.
 */
export async function respondToEventOp(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
  args: RespondToEventArgs,
): Promise<MappedEvent> {
  const { row, capabilities } = await resolveEventForWrite(
    ctx,
    userId,
    args.eventId,
    ["canRespond"],
  );

  const live = await getCalendarEvent(
    accessToken,
    row.calendarId,
    row.googleEventId,
  );
  const attendees = (live.attendees ?? []).map((a) =>
    a.self ? { ...a, responseStatus: args.responseStatus } : a,
  );

  const event = await patchCalendarEvent(
    accessToken,
    row.calendarId,
    row.googleEventId,
    { attendees },
    // Tell the organiser you answered — unless the organiser is you.
    capabilities.isOrganizer ? "none" : "all",
  );

  await mirrorEvent(ctx, userId, event, "Invitation response updated.");
  return event;
}

/**
 * Delete an event, meaning one of two different things.
 *
 * As its organizer, this cancels the event for everyone and mails them about
 * it. As a mere guest, the copy on your calendar is yours alone: deleting it
 * removes it from your view, leaves the organizer's copy untouched, and tells
 * nobody. The frontend labels the button accordingly ("Delete event" vs.
 * "Remove from my calendar") — the two are not the same act and shouldn't read
 * as though they were. Declining, if that's what the user means, is the RSVP
 * control; this deliberately doesn't decline on their behalf.
 */
export async function deleteEventOp(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
  args: { eventId: Id<"events"> },
): Promise<null> {
  const { row, capabilities } = await resolveEventForWrite(
    ctx,
    userId,
    args.eventId,
    ["canDelete", "canRemoveSelf"],
  );

  const hasGuests = (row.attendees?.length ?? 0) > 0;
  try {
    await deleteCalendarEvent(
      accessToken,
      row.calendarId,
      row.googleEventId,
      // Only the organizer's delete is a cancellation worth emailing about.
      capabilities.isOrganizer && hasGuests ? "all" : "none",
    );
  } catch (error) {
    // A retry after an uncertain response sees 404 once the first delete won.
    if (!(error instanceof GoogleApiError) || error.status !== 404) throw error;
  }

  try {
    await ctx.runMutation(internal.calendar.deleteEventRow, {
      eventId: args.eventId,
      userId,
    });
  } catch (error) {
    throw new ExternalWriteCommittedError("Event deleted.", error);
  }
  return null;
}
