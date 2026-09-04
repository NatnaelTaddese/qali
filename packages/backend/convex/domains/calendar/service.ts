/** Connection-aware calendar writes against the provider-neutral adapter port.
 * Registration of the public actions is canonical here, under
 * `api.domains.calendar.service.*`. */

import {
  eventCapabilities,
  type EventCapabilities,
} from "@qali/domain/permissions";
import { v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { action, type ActionCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  ExternalWriteCommittedError,
  isDefinitiveProviderFailure,
  ProviderError,
} from "../../integrations/calendar/errors";
import { refreshConnectionCalendar } from "../sync/engine";
import { getCalendarAdapter } from "../../integrations/calendar/registry";
import { createEventReconciling } from "../../integrations/calendar/service";
import type {
  CalendarProviderAdapter,
  EventAttendeeInput,
  EventPatch,
  ProviderEvent,
} from "../../integrations/calendar/types";
import { hostEmailForTarget, withHostAttendee } from "./hostAttendee";
import { shiftRecurringMasterRange } from "./recurrence";
import { calendarRequestFingerprint } from "./operationIdentity";
import { eventIdArg, responseStatusValidator } from "./validators";

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

export { ExternalWriteCommittedError, isDefinitiveProviderFailure };

export interface CalendarServiceDependencies {
  getAdapter?(
    ctx: ActionCtx,
    userId: string,
    connectionId: Id<"calendarConnections">,
  ): Promise<CalendarProviderAdapter>;
  refreshCalendar?(
    ctx: ActionCtx,
    userId: string,
    connectionId: Id<"calendarConnections">,
    localCalendarId: Id<"calendars">,
  ): Promise<void>;
}

type WriteTarget = {
  event: Doc<"events">;
  calendar: Doc<"calendars">;
  connectionId: Id<"calendarConnections">;
  localCalendarId: Id<"calendars">;
  providerCalendarId: string;
  providerEventId: string;
  providerSeriesId?: string;
};

type CreateTarget = {
  connectionId: Id<"calendarConnections">;
  localCalendarId: Id<"calendars">;
  providerCalendarId: string;
  /** The owner's email when known; see resolveCreateTargetHandler. */
  accountEmail?: string;
};

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

function providerEventValue(event: ProviderEvent) {
  return {
    ...event,
    attendees: event.attendees?.map((attendee) => ({ ...attendee })),
    recurrence: event.recurrence ? [...event.recurrence] : undefined,
    organizer: event.organizer ? { ...event.organizer } : undefined,
    creator: event.creator ? { ...event.creator } : undefined,
    conference: event.conference ? { ...event.conference } : undefined,
  };
}

async function adapterFor(
  ctx: ActionCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
  dependencies?: CalendarServiceDependencies,
): Promise<CalendarProviderAdapter> {
  return dependencies?.getAdapter
    ? await dependencies.getAdapter(ctx, userId, connectionId)
    : await getCalendarAdapter(ctx, userId, connectionId);
}

async function refreshTarget(
  ctx: ActionCtx,
  userId: string,
  target: Pick<WriteTarget | CreateTarget, "connectionId" | "localCalendarId">,
  dependencies?: CalendarServiceDependencies,
): Promise<void> {
  await (dependencies?.refreshCalendar ?? refreshConnectionCalendar)(
    ctx,
    userId,
    target.connectionId,
    target.localCalendarId,
  );
}

async function mirrorEvent(
  ctx: ActionCtx,
  userId: string,
  target: Pick<CreateTarget, "connectionId" | "localCalendarId">,
  event: ProviderEvent,
  successSummary: string,
): Promise<void> {
  try {
    await ctx.runMutation(internal.domains.calendar.mutations.mirrorProviderEvent, {
      userId,
      connectionId: target.connectionId,
      localCalendarId: target.localCalendarId,
      event: providerEventValue(event),
    });
  } catch (error) {
    throw new ExternalWriteCommittedError(successSummary, error);
  }
}

async function cacheSeries(
  ctx: ActionCtx,
  userId: string,
  target: Pick<CreateTarget, "connectionId" | "localCalendarId">,
  event: ProviderEvent,
  recurrence: readonly string[],
  replacedEventId?: Id<"events">,
): Promise<void> {
  await ctx.runMutation(internal.domains.calendar.mutations.upsertProviderRecurringSeries, {
    userId,
    connectionId: target.connectionId,
    localCalendarId: target.localCalendarId,
    providerEventId: event.id,
    recurrence: [...recurrence],
    providerUpdatedMs: event.updatedMs,
    replacedEventId,
  });
}

export async function resolveEventForWrite(
  ctx: ActionCtx,
  userId: string,
  eventId: Id<"events">,
  allowed: EventCapabilityName[],
): Promise<{
  row: Doc<"events">;
  capabilities: EventCapabilities;
  target: WriteTarget;
}> {
  const target = (await ctx.runMutation(
    internal.domains.calendar.mutations.resolveEventWriteTarget,
    { eventId, userId },
  )) as WriteTarget | null;
  if (!target) throw new Error("Event not found");

  const capabilities = eventCapabilities(target.event, target.calendar);
  if (!allowed.some((name) => capabilities[name])) {
    throw new Error(
      allowed[0] === "canEdit" && capabilities.readOnlyReason
        ? capabilities.readOnlyReason
        : CAPABILITY_DENIAL[allowed[0]],
    );
  }
  return { row: target.event, capabilities, target };
}

type OperationKind = "create" | "update" | "delete" | "respond";

async function claimWrite(
  ctx: ActionCtx,
  userId: string,
  target: CreateTarget,
  kind: OperationKind,
  operationId: string | undefined,
  providerEventId?: string,
  targetEventId?: Id<"events">,
  requestFingerprint = calendarRequestFingerprint({}),
) {
  const idempotencyKey = operationId ?? crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const claim = await ctx.runMutation(internal.domains.calendar.mutations.claimCalendarOperation, {
    userId,
    connectionId: target.connectionId,
    localCalendarId: target.localCalendarId,
    providerCalendarId: target.providerCalendarId,
    providerEventId,
    targetEventId,
    targetProviderEventId: providerEventId,
    requestFingerprint,
    idempotencyKey,
    kind,
    attemptId,
  });
  return { ...claim, idempotencyKey, attemptId };
}

async function settleWrite(
  ctx: ActionCtx,
  userId: string,
  target: Pick<CreateTarget, "connectionId">,
  operation: { idempotencyKey: string; attemptId: string },
  status: "succeeded" | "ambiguous" | "failed",
  providerEventId?: string,
  error?: unknown,
): Promise<void> {
  try {
    const settled = await ctx.runMutation(internal.domains.calendar.mutations.settleCalendarOperation, {
      userId,
      connectionId: target.connectionId,
      idempotencyKey: operation.idempotencyKey,
      attemptId: operation.attemptId,
      status,
      providerEventId,
      error:
        error instanceof Error ? error.message : error ? String(error) : undefined,
    });
    if (!settled && status === "succeeded") {
      throw new Error("Calendar operation claim was lost");
    }
  } catch (settleError) {
    if (status === "succeeded") {
      throw new ExternalWriteCommittedError(
        "Calendar change saved.",
        settleError,
      );
    }
    throw settleError;
  }
}

async function providerFailure(
  ctx: ActionCtx,
  userId: string,
  target: Pick<CreateTarget, "connectionId">,
  operation: { idempotencyKey: string; attemptId: string },
  error: unknown,
): Promise<never> {
  await settleWrite(
    ctx,
    userId,
    target,
    operation,
    isDefinitiveProviderFailure(error) ? "failed" : "ambiguous",
    undefined,
    error,
  );
  throw error;
}

function requireCapability(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

function eventAttendees(
  attendees: readonly { email?: string; displayName?: string; optional?: boolean }[] |
    undefined,
): EventAttendeeInput[] | undefined {
  return attendees
    ?.filter(
      (attendee): attendee is typeof attendee & { email: string } =>
        Boolean(attendee.email),
    )
    .map(({ email, displayName, optional }) => ({ email, displayName, optional }));
}

function conferencePatch(
  conference: "meet" | null | undefined,
): EventPatch["conference"] | undefined {
  return conference === undefined
    ? undefined
    : conference === null
      ? "remove"
      : "add";
}

function providerVersion(row: Doc<"events">): number | undefined {
  return row.providerUpdatedMs;
}

function toRRuleUntil(ms: number, allDay: boolean): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  return allDay
    ? day
    : `${day}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export function truncateRecurrence(
  recurrence: readonly string[],
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
  calendarId?: Id<"calendars">;
  color?: string;
  visibility?: string;
  busy?: boolean;
  recurrence?: string[];
  attendees?: { email: string; displayName?: string }[];
  timeZone?: string;
  addConference?: boolean;
  operationId?: string;
}

export async function createEventOp(
  ctx: ActionCtx,
  userId: string,
  args: CreateEventArgs,
  dependencies?: CalendarServiceDependencies,
): Promise<ProviderEvent> {
  validateTimePair(args.startMs, args.endMs, true);
  const target = (await ctx.runMutation(internal.domains.calendar.mutations.resolveCreateTarget, {
    userId,
    requestedCalendarId: args.calendarId,
  })) as CreateTarget;
  const adapter = await adapterFor(ctx, userId, target.connectionId, dependencies);
  if (args.recurrence?.length) {
    requireCapability(
      adapter.capabilities.recurringEvents,
      "This calendar provider does not support recurring events",
    );
  }
  if (args.addConference) {
    requireCapability(
      adapter.capabilities.conference.create,
      "This calendar provider cannot create conferences",
    );
  }
  const operation = await claimWrite(
    ctx,
    userId,
    target,
    "create",
    args.operationId,
    undefined,
    undefined,
    calendarRequestFingerprint({
      summary: args.summary,
      startMs: args.startMs,
      endMs: args.endMs,
      description: args.description,
      location: args.location,
      allDay: args.allDay,
      color: args.color,
      visibility: args.visibility,
      busy: args.busy,
      recurrence: args.recurrence,
      attendees: args.attendees,
      timeZone: args.timeZone,
      addConference: args.addConference,
    }),
  );
  let event: ProviderEvent;
  try {
    if (operation.state === "succeeded") {
      if (!operation.providerEventId) {
        throw new Error("Completed calendar create is missing its event id");
      }
      event = await adapter.getEvent({
        calendarId: target.providerCalendarId,
        eventId: operation.providerEventId,
      });
    } else {
      event = await createEventReconciling(adapter, {
        calendarId: target.providerCalendarId,
        event: {
          summary: args.summary,
          startMs: args.startMs,
          endMs: args.endMs,
          description: args.description,
          location: args.location,
          allDay: args.allDay,
          color: args.color,
          visibility: args.visibility,
          busy: args.busy,
          recurrence: args.recurrence,
          // The host joins a guest list as the accepted organizer; the
          // fingerprint above hashes the request as sent, without that entry.
          attendees: withHostAttendee(args.attendees, {
            email: target.accountEmail,
          }),
          timeZone: args.timeZone,
          conference: args.addConference ? "add" : undefined,
        },
        notify: args.attendees?.length ? "all" : undefined,
        idempotencyKey: operation.idempotencyKey,
      });
      await settleWrite(
        ctx,
        userId,
        target,
        operation,
        "succeeded",
        event.id,
      );
    }
  } catch (error) {
    if (error instanceof ExternalWriteCommittedError) throw error;
    if (operation.state === "succeeded") {
      throw new ExternalWriteCommittedError(`Created “${args.summary}”.`, error);
    }
    return await providerFailure(ctx, userId, target, operation, error);
  }

  if (args.recurrence?.length) {
    try {
      await cacheSeries(ctx, userId, target, event, args.recurrence);
      await refreshTarget(ctx, userId, target, dependencies);
    } catch (error) {
      throw new ExternalWriteCommittedError(`Created “${args.summary}”.`, error);
    }
  } else {
    await mirrorEvent(ctx, userId, target, event, `Created “${args.summary}”.`);
  }
  return event;
}

export interface UpdateEventTimeArgs {
  eventId: Id<"events">;
  startMs: number;
  endMs: number;
  timeZone?: string;
  operationId?: string;
}

export type UpdateEventScope = "thisEvent" | "thisAndFollowing" | "allEvents";
export type DeleteEventScope = UpdateEventScope;

export interface UpdateEventArgs {
  eventId: Id<"events">;
  summary?: string;
  description?: string | null;
  location?: string | null;
  color?: string | null;
  visibility?: string | null;
  busy?: boolean;
  startMs?: number;
  endMs?: number;
  allDay?: boolean;
  attendees?: EventAttendeeInput[];
  recurrence?: string[];
  timeZone?: string;
  conference?: "meet" | null;
  scope?: UpdateEventScope;
  operationId?: string;
  expectedProviderUpdatedMs?: number;
  expectedSeriesUpdatedMs?: number;
}

function basePatch(
  args: UpdateEventArgs,
  attendees: readonly EventAttendeeInput[] | undefined = args.attendees,
): EventPatch {
  return {
    summary: args.summary,
    description: args.description,
    location: args.location,
    color: args.color,
    visibility: args.visibility,
    busy: args.busy,
    attendees,
    conference: conferencePatch(args.conference),
  };
}

async function finishUpdate(
  ctx: ActionCtx,
  userId: string,
  target: WriteTarget,
  operation: Awaited<ReturnType<typeof claimWrite>>,
  event: ProviderEvent,
): Promise<void> {
  if (operation.state !== "succeeded") {
    await settleWrite(ctx, userId, target, operation, "succeeded", event.id);
  }
}

export async function updateEventTimeOp(
  ctx: ActionCtx,
  userId: string,
  args: UpdateEventTimeArgs,
  dependencies?: CalendarServiceDependencies,
): Promise<ProviderEvent> {
  validateTimePair(args.startMs, args.endMs, true);
  return await updateEventOp(
    ctx,
    userId,
    {
      eventId: args.eventId,
      startMs: args.startMs,
      endMs: args.endMs,
      timeZone: args.timeZone,
      operationId: args.operationId,
    },
    dependencies,
  );
}

export async function updateEventOp(
  ctx: ActionCtx,
  userId: string,
  args: UpdateEventArgs,
  dependencies?: CalendarServiceDependencies,
): Promise<ProviderEvent> {
  const hasTimeChange = validateTimePair(args.startMs, args.endMs, false);
  const { row, capabilities, target } = await resolveEventForWrite(
    ctx,
    userId,
    args.eventId,
    ["canEdit"],
  );
  const adapter = await adapterFor(ctx, userId, target.connectionId, dependencies);
  const allDay = args.allDay ?? row.allDay;
  const expectedUpdatedMs = args.expectedProviderUpdatedMs;
  if (
    (args.attendees !== undefined || args.recurrence !== undefined) &&
    expectedUpdatedMs !== undefined &&
    providerVersion(row) !== expectedUpdatedMs
  ) {
    throw new Error(
      args.recurrence !== undefined
        ? "The event changed after this recurring-event proposal was made. Please propose it again."
        : "The event changed after this guest-list proposal was made. Please propose it again.",
    );
  }
  if (args.attendees !== undefined) {
    if (!capabilities.canInviteOthers) {
      throw new Error("The organiser does not allow you to invite or remove guests");
    }
    requireCapability(
      adapter.capabilities.attendeeMembershipUpdates,
      "This calendar provider cannot replace attendee membership",
    );
  }
  // The host joins a guest list as the accepted organizer on edits too, so an
  // event that gains its first guest here matches one created with guests.
  // The fingerprint below hashes the request as sent, without that entry.
  const attendees = withHostAttendee(args.attendees, {
    email: hostEmailForTarget(target.calendar),
  });
  if (args.recurrence !== undefined) {
    if (args.recurrence.length === 0) {
      throw new Error("A recurring event needs a recurrence rule");
    }
    if (!capabilities.canChangeRecurrence) {
      throw new Error("This event is already part of a recurring series");
    }
    requireCapability(
      adapter.capabilities.recurringEvents,
      "This calendar provider does not support recurring events",
    );
    if (!allDay && !args.timeZone) {
      throw new Error("A time zone is required to make a timed event repeat");
    }
  }
  if (args.conference === "meet") {
    requireCapability(
      adapter.capabilities.conference.add,
      "This calendar provider cannot add conferences",
    );
  }
  if (args.conference === null) {
    requireCapability(
      adapter.capabilities.conference.remove,
      "This calendar provider cannot remove conferences",
    );
  }

  const scope = target.providerSeriesId
    ? (args.scope ?? "thisEvent")
    : "thisEvent";
  const notify = args.attendees !== undefined ? ("all" as const) : undefined;
  const operation = await claimWrite(
    ctx,
    userId,
    target,
    "update",
    args.operationId,
    target.providerEventId,
    target.event._id,
    calendarRequestFingerprint({
      summary: args.summary,
      description: args.description,
      location: args.location,
      color: args.color,
      visibility: args.visibility,
      busy: args.busy,
      startMs: args.startMs,
      endMs: args.endMs,
      allDay: args.allDay,
      attendees: args.attendees,
      recurrence: args.recurrence,
      timeZone: args.timeZone,
      conference: args.conference,
      scope,
      expectedProviderUpdatedMs: expectedUpdatedMs,
      expectedSeriesUpdatedMs: args.expectedSeriesUpdatedMs,
    }),
  );
  if (operation.state === "succeeded") {
    try {
      const event = await adapter.getEvent({
        calendarId: target.providerCalendarId,
        eventId: operation.providerEventId ?? target.providerEventId,
      });
      if (scope === "thisEvent" && args.recurrence === undefined) {
        await mirrorEvent(ctx, userId, target, event, "Event updated.");
      } else {
        await refreshTarget(ctx, userId, target, dependencies);
      }
      return event;
    } catch (error) {
      if (error instanceof ExternalWriteCommittedError) throw error;
      throw new ExternalWriteCommittedError("Event updated.", error);
    }
  }

  try {
    if (args.recurrence !== undefined) {
      const event = await adapter.updateEvent({
        ref: {
          calendarId: target.providerCalendarId,
          eventId: target.providerEventId,
        },
        patch: {
          ...basePatch(args, attendees),
          startMs: hasTimeChange ? args.startMs : row.startMs,
          endMs: hasTimeChange ? args.endMs : row.endMs,
          allDay,
          timeZone: args.timeZone,
          recurrence: args.recurrence,
        },
        notify,
        idempotencyKey: operation.idempotencyKey,
        expectedUpdatedMs,
        knownAttendeeEmails: row.attendees?.map((attendee) => attendee.email),
      });
      await finishUpdate(ctx, userId, target, operation, event);
      try {
        await cacheSeries(ctx, userId, target, event, args.recurrence, row._id);
        await refreshTarget(ctx, userId, target, dependencies);
      } catch (error) {
        throw new ExternalWriteCommittedError("Event made recurring.", error);
      }
      return event;
    }

    if (scope === "thisEvent") {
      const event = await adapter.updateEvent({
        ref: {
          calendarId: target.providerCalendarId,
          eventId: target.providerEventId,
        },
        patch: {
          ...basePatch(args, attendees),
          ...(hasTimeChange
            ? {
                startMs: args.startMs,
                endMs: args.endMs,
                allDay,
                timeZone: args.timeZone,
              }
            : {}),
        },
        notify,
        idempotencyKey: operation.idempotencyKey,
        expectedUpdatedMs:
          args.attendees !== undefined ? expectedUpdatedMs : undefined,
        knownAttendeeEmails: row.attendees?.map((attendee) => attendee.email),
      });
      await finishUpdate(ctx, userId, target, operation, event);
      await mirrorEvent(ctx, userId, target, event, "Event updated.");
      return event;
    }

    const masterId = target.providerSeriesId;
    if (!masterId) throw new Error("Event is not part of a recurring series");
    const master = await adapter.getEvent({
      calendarId: target.providerCalendarId,
      eventId: masterId,
    });
    const effectiveTimeZone = args.timeZone ?? master.timeZone;
    let shifted: Pick<EventPatch, "startMs" | "endMs" | "allDay" | "timeZone"> = {};
    if (hasTimeChange && args.startMs !== undefined && args.endMs !== undefined) {
      const range = shiftRecurringMasterRange({
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
      shifted = {
        startMs: range.startMs,
        endMs: range.endMs,
        allDay,
        timeZone: effectiveTimeZone,
      };
    }
    const isSeriesHead = row.startMs === master.startMs;
    if (scope === "allEvents" || isSeriesHead) {
      const event = await adapter.updateEvent({
        ref: { calendarId: target.providerCalendarId, eventId: masterId },
        patch: { ...basePatch(args, attendees), ...shifted },
        notify,
        idempotencyKey: operation.idempotencyKey,
        expectedUpdatedMs:
          args.attendees !== undefined ? args.expectedSeriesUpdatedMs : undefined,
        knownAttendeeEmails: row.attendees?.map((attendee) => attendee.email),
      });
      await finishUpdate(ctx, userId, target, operation, event);
      try {
        await refreshTarget(ctx, userId, target, dependencies);
      } catch (error) {
        throw new ExternalWriteCommittedError("Event updated.", error);
      }
      return event;
    }

    const recurrence = master.recurrence ?? [];
    const truncated = truncateRecurrence(
      recurrence,
      row.startMs - 1_000,
      row.allDay,
    );
    const alreadyTruncated =
      JSON.stringify(recurrence) === JSON.stringify(truncated);
    if (
      !alreadyTruncated &&
      args.attendees !== undefined &&
      args.expectedSeriesUpdatedMs !== undefined &&
      master.updatedMs !== args.expectedSeriesUpdatedMs
    ) {
      throw new Error(
        "The event changed after this guest-list proposal was made. Please propose it again.",
      );
    }

    const carried = <T>(edited: T | null | undefined, current: T | undefined) =>
      edited === undefined ? current : (edited ?? undefined);
    const tailAttendees =
      attendees === undefined ? eventAttendees(master.attendees) : attendees;
    const addConference =
      args.conference === null
        ? false
        : args.conference === "meet"
          ? true
          : Boolean(row.conferenceUrl);
    if (addConference) {
      requireCapability(
        adapter.capabilities.conference.create,
        "This calendar provider cannot create conferences",
      );
    }
    const tailKey = `${operation.idempotencyKey}:tail`;
    const tailRequest = (idempotencyKey: string) => ({
      calendarId: target.providerCalendarId,
      attendeeSourceRef: {
        calendarId: target.providerCalendarId,
        eventId: masterId,
      },
      knownAttendeeEmails: row.attendees?.map((attendee) => attendee.email),
      event: {
        summary: args.summary ?? row.summary ?? "(No title)",
        description: carried(args.description, row.description),
        location: carried(args.location, row.location),
        startMs: hasTimeChange ? args.startMs! : row.startMs,
        endMs: hasTimeChange ? args.endMs! : row.endMs,
        allDay,
        color: carried(args.color, row.color),
        visibility: carried(args.visibility, row.visibility),
        busy: args.busy === undefined ? row.busy : args.busy,
        attendees: tailAttendees,
        recurrence,
        timeZone: effectiveTimeZone,
        conference: addConference ? ("add" as const) : undefined,
      },
      notify: tailAttendees?.length ? ("all" as const) : undefined,
      idempotencyKey,
    });
    let tail = await createEventReconciling(adapter, tailRequest(tailKey));
    if (tail.status === "cancelled") {
      tail = await createEventReconciling(
        adapter,
        tailRequest(`${operation.idempotencyKey}:tail-retry`),
      );
      if (tail.status === "cancelled") {
        throw new ProviderError(
          "conflict",
          "The replacement series was cancelled; propose the split again",
        );
      }
    }

    let truncatedMaster = master;
    if (!alreadyTruncated) {
      try {
        truncatedMaster = await adapter.updateEvent({
          ref: { calendarId: target.providerCalendarId, eventId: masterId },
          patch: { recurrence: truncated },
          idempotencyKey: `${operation.idempotencyKey}:truncate`,
        });
      } catch (error) {
        if (isDefinitiveProviderFailure(error)) {
          await adapter.deleteEvent({
            ref: { calendarId: target.providerCalendarId, eventId: tail.id },
            mode: "cancel",
            notify: tailAttendees?.length ? "all" : "none",
            idempotencyKey: `${operation.idempotencyKey}:compensate-tail`,
          });
        }
        throw error;
      }
    }
    await finishUpdate(ctx, userId, target, operation, tail);
    try {
      await cacheSeries(ctx, userId, target, truncatedMaster, truncated);
      await cacheSeries(ctx, userId, target, tail, tail.recurrence ?? recurrence);
      await refreshTarget(ctx, userId, target, dependencies);
    } catch (error) {
      throw new ExternalWriteCommittedError("Event series updated.", error);
    }
    return tail;
  } catch (error) {
    if (error instanceof ExternalWriteCommittedError) throw error;
    return await providerFailure(ctx, userId, target, operation, error);
  }
}

export interface RespondToEventArgs {
  eventId: Id<"events">;
  responseStatus: "accepted" | "tentative" | "declined";
  operationId?: string;
}

export async function respondToEventOp(
  ctx: ActionCtx,
  userId: string,
  args: RespondToEventArgs,
  dependencies?: CalendarServiceDependencies,
): Promise<ProviderEvent> {
  const { capabilities, target } = await resolveEventForWrite(
    ctx,
    userId,
    args.eventId,
    ["canRespond"],
  );
  const adapter = await adapterFor(ctx, userId, target.connectionId, dependencies);
  requireCapability(
    adapter.capabilities.rsvp,
    "This calendar provider does not support invitation responses",
  );
  const operation = await claimWrite(
    ctx,
    userId,
    target,
    "respond",
    args.operationId,
    target.providerEventId,
    target.event._id,
    calendarRequestFingerprint({ responseStatus: args.responseStatus }),
  );
  try {
    const event =
      operation.state === "succeeded"
        ? await adapter.getEvent({
            calendarId: target.providerCalendarId,
            eventId: operation.providerEventId ?? target.providerEventId,
          })
        : await adapter.respondToEvent({
            ref: {
              calendarId: target.providerCalendarId,
              eventId: target.providerEventId,
            },
            responseStatus: args.responseStatus,
            notify: capabilities.isOrganizer ? "none" : "all",
            idempotencyKey: operation.idempotencyKey,
          });
    if (operation.state !== "succeeded") {
      await settleWrite(ctx, userId, target, operation, "succeeded", event.id);
    }
    await mirrorEvent(ctx, userId, target, event, "Invitation response updated.");
    return event;
  } catch (error) {
    if (error instanceof ExternalWriteCommittedError) {
      throw error;
    }
    if (operation.state === "succeeded") {
      throw new ExternalWriteCommittedError(
        "Invitation response updated.",
        error,
      );
    }
    return await providerFailure(ctx, userId, target, operation, error);
  }
}

export interface DeleteEventArgs {
  eventId: Id<"events">;
  scope?: DeleteEventScope;
  operationId?: string;
  expectedSeriesUpdatedMs?: number;
}

async function cleanDeletedMirror(
  ctx: ActionCtx,
  userId: string,
  target: WriteTarget,
  providerSeriesId?: string,
): Promise<void> {
  await ctx.runMutation(internal.domains.calendar.mutations.deleteProviderEventMirror, {
    eventId: target.event._id,
    userId,
    connectionId: target.connectionId,
    localCalendarId: target.localCalendarId,
    providerSeriesId,
  });
}

export async function deleteEventOp(
  ctx: ActionCtx,
  userId: string,
  args: DeleteEventArgs,
  dependencies?: CalendarServiceDependencies,
): Promise<null> {
  const { row, capabilities, target } = await resolveEventForWrite(
    ctx,
    userId,
    args.eventId,
    ["canDelete", "canRemoveSelf"],
  );
  const scope = target.providerSeriesId
    ? (args.scope ?? "thisEvent")
    : "thisEvent";
  if (scope === "thisAndFollowing" && !capabilities.isOrganizer) {
    throw new Error(
      "Only the organizer can remove this and following events from the series",
    );
  }
  const adapter = await adapterFor(ctx, userId, target.connectionId, dependencies);
  if (!capabilities.isOrganizer) {
    requireCapability(
      adapter.capabilities.removeSelf,
      "This calendar provider cannot remove an invitation copy",
    );
  }
  const notify =
    capabilities.isOrganizer && (row.attendees?.length ?? 0) > 0
      ? ("all" as const)
      : ("none" as const);
  const operation = await claimWrite(
    ctx,
    userId,
    target,
    "delete",
    args.operationId,
    target.providerEventId,
    target.event._id,
    calendarRequestFingerprint({
      scope,
      expectedSeriesUpdatedMs: args.expectedSeriesUpdatedMs,
    }),
  );
  if (operation.state === "succeeded") {
    try {
      await cleanDeletedMirror(
        ctx,
        userId,
        target,
        scope === "allEvents" ? target.providerSeriesId : undefined,
      );
      if (scope !== "thisEvent") {
        await refreshTarget(ctx, userId, target, dependencies);
      }
      return null;
    } catch (error) {
      throw new ExternalWriteCommittedError("Event deleted.", error);
    }
  }

  try {
    if (target.providerSeriesId && scope === "thisAndFollowing") {
      let instance: ProviderEvent;
      try {
        instance = await adapter.getEvent({
          calendarId: target.providerCalendarId,
          eventId: target.providerEventId,
        });
      } catch (error) {
        if (!(error instanceof ProviderError) || error.kind !== "not-found") {
          throw error;
        }
        await settleWrite(ctx, userId, target, operation, "succeeded");
        try {
          await cleanDeletedMirror(ctx, userId, target);
          await refreshTarget(ctx, userId, target, dependencies);
        } catch (syncError) {
          throw new ExternalWriteCommittedError(
            "This and following events deleted.",
            syncError,
          );
        }
        return null;
      }
      const master = await adapter.getEvent({
        calendarId: target.providerCalendarId,
        eventId: target.providerSeriesId,
      });
      const originalStartMs = instance.originalOccurrenceStartMs ?? instance.startMs;
      if (originalStartMs === master.startMs) {
        await adapter.deleteEvent({
          ref: {
            calendarId: target.providerCalendarId,
            eventId: target.providerSeriesId,
          },
          mode: capabilities.isOrganizer ? "cancel" : "remove-self",
          notify,
          idempotencyKey: operation.idempotencyKey,
        });
        await settleWrite(
          ctx,
          userId,
          target,
          operation,
          "succeeded",
          target.providerSeriesId,
        );
        try {
          await cleanDeletedMirror(ctx, userId, target, target.providerSeriesId);
          await refreshTarget(ctx, userId, target, dependencies);
        } catch (error) {
          throw new ExternalWriteCommittedError("Event series deleted.", error);
        }
        return null;
      }
      const recurrence = master.recurrence ?? [];
      if (!recurrence.some((line) => line.startsWith("RRULE:"))) {
        throw new Error("The recurring series has no recurrence rule to truncate");
      }
      const truncated = truncateRecurrence(
        recurrence,
        originalStartMs - 1_000,
        master.allDay,
      );
      const alreadyTruncated =
        JSON.stringify(recurrence) === JSON.stringify(truncated);
      if (
        !alreadyTruncated &&
        args.expectedSeriesUpdatedMs !== undefined &&
        master.updatedMs !== args.expectedSeriesUpdatedMs
      ) {
        throw new Error(
          "The recurring series changed after this deletion was proposed. Please propose it again.",
        );
      }
      const updatedMaster = alreadyTruncated
        ? master
        : await adapter.updateEvent({
            ref: {
              calendarId: target.providerCalendarId,
              eventId: target.providerSeriesId,
            },
            patch: { recurrence: truncated },
            notify,
            idempotencyKey: operation.idempotencyKey,
          });
      await settleWrite(
        ctx,
        userId,
        target,
        operation,
        "succeeded",
        updatedMaster.id,
      );
      try {
        await cacheSeries(ctx, userId, target, updatedMaster, truncated);
        await cleanDeletedMirror(ctx, userId, target);
        await refreshTarget(ctx, userId, target, dependencies);
      } catch (error) {
        throw new ExternalWriteCommittedError(
          "This and following events deleted.",
          error,
        );
      }
      return null;
    }

    const providerSeriesId =
      target.providerSeriesId && scope === "allEvents"
        ? target.providerSeriesId
        : undefined;
    await adapter.deleteEvent({
      ref: {
        calendarId: target.providerCalendarId,
        eventId: providerSeriesId ?? target.providerEventId,
      },
      mode: capabilities.isOrganizer ? "cancel" : "remove-self",
      notify,
      idempotencyKey: operation.idempotencyKey,
    });
    await settleWrite(
      ctx,
      userId,
      target,
      operation,
      "succeeded",
      providerSeriesId ?? target.providerEventId,
    );
    try {
      await cleanDeletedMirror(ctx, userId, target, providerSeriesId);
      if (providerSeriesId) {
        await refreshTarget(ctx, userId, target, dependencies);
      }
    } catch (error) {
      throw new ExternalWriteCommittedError(
        providerSeriesId ? "Event series deleted." : "Event deleted.",
        error,
      );
    }
    return null;
  } catch (error) {
    if (error instanceof ExternalWriteCommittedError) throw error;
    return await providerFailure(ctx, userId, target, operation, error);
  }
}

async function authedUser(ctx: ActionCtx): Promise<string> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("Not authenticated");
  return user._id;
}

/** The provider-neutral result shape of the public calendar actions.
 * `providerCalendarId` is the provider's calendar id string, not a local
 * `calendars` reference. */
export function calendarActionEvent(event: ProviderEvent) {
  return {
    providerEventId: event.id,
    providerCalendarId: event.calendarId,
    providerUpdatedMs: event.updatedMs,
    providerSeriesId: event.seriesId,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startMs: event.startMs,
    endMs: event.endMs,
    allDay: event.allDay,
    status: event.status,
    htmlLink: event.htmlLink,
    color: event.color,
    visibility: event.visibility,
    busy: event.busy,
    attendees: event.attendees
      ?.filter(
        (attendee): attendee is typeof attendee & { email: string } =>
          attendee.email !== undefined,
      )
      .map((attendee) => ({
        email: attendee.email,
        displayName: attendee.displayName,
        responseStatus: attendee.responseStatus,
        organizer: attendee.organizer,
        self: attendee.self,
        optional: attendee.optional,
      })),
    attendeesOmitted: event.attendeesOmitted,
    organizer: event.organizer,
    creator: event.creator,
    guestsCanModify: event.guestsCanModify,
    guestsCanInviteOthers: event.guestsCanInviteOthers,
    guestsCanSeeOtherGuests: event.guestsCanSeeOtherGuests,
    locked: event.locked,
    eventType: event.eventType,
    conferenceUrl: event.conference?.url,
    conferenceName: event.conference?.name,
    conferenceType: event.conference?.type,
  };
}

export async function createEventHandler(
  ctx: ActionCtx,
  args: CreateEventArgs,
): Promise<ReturnType<typeof calendarActionEvent>> {
  return calendarActionEvent(
    await createEventOp(ctx, await authedUser(ctx), args),
  );
}

export async function refreshEventRecurrenceHandler(
  ctx: ActionCtx,
  { eventId }: { eventId: Id<"events"> | Id<"sharedEvents"> },
): Promise<null> {
  const userId = await authedUser(ctx);
  const context = await ctx.runQuery(internal.domains.calendar.queries.getEventContext, {
    eventId,
    userId,
  });
  if (!context) throw new Error("Event not found");
  if (!context.event.providerSeriesId) {
    return null;
  }
  const target = (await ctx.runMutation(
    internal.domains.calendar.mutations.resolveEventWriteTarget,
    { eventId: context.event._id, userId },
  )) as WriteTarget | null;
  if (!target) throw new Error("Event not found");
  if (!target.providerSeriesId) return null;
  const adapter = await adapterFor(ctx, userId, target.connectionId);
  const master = await adapter.getEvent({
    calendarId: target.providerCalendarId,
    eventId: target.providerSeriesId,
  });
  await cacheSeries(
    ctx,
    userId,
    target,
    master,
    master.recurrence ?? [],
  );
  return null;
}

export async function updateEventTimeHandler(
  ctx: ActionCtx,
  args: UpdateEventTimeArgs,
): Promise<ReturnType<typeof calendarActionEvent>> {
  return calendarActionEvent(
    await updateEventTimeOp(ctx, await authedUser(ctx), args),
  );
}

export async function updateEventHandler(
  ctx: ActionCtx,
  args: UpdateEventArgs,
): Promise<ReturnType<typeof calendarActionEvent>> {
  return calendarActionEvent(
    await updateEventOp(ctx, await authedUser(ctx), args),
  );
}

export async function respondToEventHandler(
  ctx: ActionCtx,
  args: RespondToEventArgs,
): Promise<ReturnType<typeof calendarActionEvent>> {
  return calendarActionEvent(
    await respondToEventOp(ctx, await authedUser(ctx), args),
  );
}

export async function deleteEventHandler(
  ctx: ActionCtx,
  args: DeleteEventArgs,
): Promise<null> {
  return await deleteEventOp(ctx, await authedUser(ctx), args);
}

export const createEvent = action({
  args: {
    summary: v.string(),
    startMs: v.number(),
    endMs: v.number(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    allDay: v.optional(v.boolean()),
    /** Owned local calendar to create in; defaults to the user's primary. */
    calendarId: v.optional(v.id("calendars")),
    /** Provider event colour override (Google: "1".."11"); absent inherits
     * the calendar. */
    color: v.optional(v.string()),
    visibility: v.optional(v.string()),
    /** Free/busy: `false` marks the event free; absent = the provider default
     * (busy). Never read with a truthiness check. */
    busy: v.optional(v.boolean()),
    /** RFC5545 recurrence lines (RRULE), e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. */
    recurrence: v.optional(v.array(v.string())),
    /** Guests to invite. Google emails each one an invitation on create. */
    attendees: v.optional(
      v.array(
        v.object({
          email: v.string(),
          displayName: v.optional(v.string()),
        }),
      ),
    ),
    /** Client IANA time zone; Google requires it for recurring timed events. */
    timeZone: v.optional(v.string()),
    /** Ask Google to mint a Google Meet link; the URL comes back as `conferenceUrl`. */
    addConference: v.optional(v.boolean()),
    /** Idempotency key, stable across retries of the same user intent. */
    operationId: v.optional(v.string()),
  },
  handler: (ctx, args) => createEventHandler(ctx, args),
});

export const refreshEventRecurrence = action({
  args: { eventId: eventIdArg },
  handler: (ctx, args) => refreshEventRecurrenceHandler(ctx, args),
});

export const updateEventTime = action({
  args: {
    eventId: v.id("events"),
    startMs: v.number(),
    endMs: v.number(),
    /** Client IANA time zone; Google needs it to anchor a timed instant. */
    timeZone: v.optional(v.string()),
  },
  handler: (ctx, args) => updateEventTimeHandler(ctx, args),
});

export const updateEvent = action({
  args: {
    eventId: v.id("events"),
    summary: v.optional(v.string()),
    /** HTML description (bold/italic/underline/links/lists). `null` clears it. */
    description: v.optional(v.union(v.string(), v.null())),
    location: v.optional(v.union(v.string(), v.null())),
    /** Provider event colour (Google: "1".."11"); `null` reverts to the
     * calendar's. */
    color: v.optional(v.union(v.string(), v.null())),
    visibility: v.optional(v.union(v.string(), v.null())),
    /** Free/busy: `true` = busy, `false` = free; absent leaves it unchanged. */
    busy: v.optional(v.boolean()),
    /** Send both ends together, or neither. All-day values are UTC-midnight
     * instants with an exclusive end, as `createEvent` expects them. */
    startMs: v.optional(v.number()),
    endMs: v.optional(v.number()),
    allDay: v.optional(v.boolean()),
    /** Replaces the guest list wholesale — anyone omitted is uninvited. Carry
     * each existing guest's `responseStatus` through or their RSVP is reset. */
    attendees: v.optional(
      v.array(
        v.object({
          email: v.string(),
          displayName: v.optional(v.string()),
          responseStatus: v.optional(responseStatusValidator),
          optional: v.optional(v.boolean()),
        }),
      ),
    ),
    /** Convert a single event into a recurring master. Existing series rules
     * are intentionally edited through neither this action nor the UI. */
    recurrence: v.optional(v.array(v.string())),
    /** Client IANA time zone; Google needs it to anchor a timed instant. */
    timeZone: v.optional(v.string()),
    /** `"meet"` mints a Google Meet link, `null` clears the existing one, and
     * absent leaves conferencing untouched. */
    conference: v.optional(v.union(v.literal("meet"), v.null())),
    /** How far the edit reaches on a recurring event. Absent = `"thisEvent"`.
     * Ignored (forced to `"thisEvent"`) for a non-recurring event. */
    scope: v.optional(
      v.union(
        v.literal("thisEvent"),
        v.literal("thisAndFollowing"),
        v.literal("allEvents"),
      ),
    ),
    /** Optimistic-concurrency guard: the `providerUpdatedMs` the proposal
     * saw. A guest-list or recurrence change made against an older version is
     * rejected instead of applied blind. */
    expectedProviderUpdatedMs: v.optional(v.number()),
    /** Idempotency key, stable across retries of the same user intent. */
    operationId: v.optional(v.string()),
  },
  handler: (ctx, args) => updateEventHandler(ctx, args),
});

export const respondToEvent = action({
  args: {
    eventId: v.id("events"),
    responseStatus: v.union(
      v.literal("accepted"),
      v.literal("tentative"),
      v.literal("declined"),
    ),
  },
  handler: (ctx, args) => respondToEventHandler(ctx, args),
});

export const deleteEvent = action({
  args: {
    eventId: v.id("events"),
    scope: v.optional(
      v.union(
        v.literal("thisEvent"),
        v.literal("thisAndFollowing"),
        v.literal("allEvents"),
      ),
    ),
    operationId: v.optional(v.string()),
  },
  handler: (ctx, args) => deleteEventHandler(ctx, args),
});
