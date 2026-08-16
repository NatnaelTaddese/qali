/** Write handlers for the calendar domain that stay on our side (no Google):
 * the visibility toggle and the optimistic-mirror internal mutations. Plain
 * functions; the root `calendar.ts` wraps each in a Convex mutation. */

import type { Infer } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import { ensureGoogleConnection } from "./connections";
import { googleEventValidator, providerEventValidator } from "./validators";

const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer"]);
const CALENDAR_OPERATION_LEASE_MS = 10 * 60 * 1000;

async function connectionForLegacyCalendar(
  ctx: MutationCtx,
  userId: string,
  calendar: Doc<"calendars">,
): Promise<Id<"calendarConnections">> {
  const connectionId =
    calendar.connectionId ?? (await ensureGoogleConnection(ctx, userId));
  const connection = await ctx.db.get(connectionId);
  if (!connection || connection.userId !== userId) {
    throw new Error("Calendar connection is unavailable");
  }
  if (
    calendar.connectionId === undefined ||
    calendar.providerCalendarId === undefined
  ) {
    await ctx.db.patch(calendar._id, {
      connectionId,
      providerCalendarId: calendar.providerCalendarId ?? calendar.googleCalendarId,
    });
  }
  return connectionId;
}

/** Resolve the legacy public calendar string to an owned, writable local row. */
export async function resolveCreateTargetHandler(
  ctx: MutationCtx,
  args: { userId: string; requestedCalendarId?: string },
) {
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .take(501);
  if (calendars.length > 500) {
    throw new Error("Too many calendars to choose a write target safely");
  }
  const calendar = args.requestedCalendarId
    ? calendars.find(
        (row) =>
          row._id === args.requestedCalendarId ||
          row.providerCalendarId === args.requestedCalendarId ||
          row.googleCalendarId === args.requestedCalendarId,
      )
    : calendars.find((row) => row.primary);
  if (!calendar) throw new Error("Calendar not found");
  if (!WRITABLE_ACCESS_ROLES.has(calendar.accessRole ?? "")) {
    throw new Error("This calendar is read-only");
  }
  const connectionId = await connectionForLegacyCalendar(
    ctx,
    args.userId,
    calendar,
  );
  return {
    connectionId,
    localCalendarId: calendar._id,
    providerCalendarId: calendar.providerCalendarId ?? calendar.googleCalendarId,
  };
}

/** Resolve and repair neutral event identity before any provider operation. */
export async function resolveEventWriteTargetHandler(
  ctx: MutationCtx,
  args: { userId: string; eventId: Id<"events"> },
) {
  const event = await ctx.db.get(args.eventId);
  if (!event || event.userId !== args.userId) return null;

  let calendar = event.localCalendarId
    ? await ctx.db.get(event.localCalendarId)
    : null;
  if (!calendar || calendar.userId !== args.userId) {
    calendar = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q.eq("userId", args.userId).eq("googleCalendarId", event.calendarId),
      )
      .unique();
  }
  if (!calendar) return null;

  const connectionId =
    event.connectionId ??
    calendar.connectionId ??
    (await ensureGoogleConnection(ctx, args.userId));
  const connection = await ctx.db.get(connectionId);
  if (!connection || connection.userId !== args.userId) {
    throw new Error("Calendar connection is unavailable");
  }
  if (calendar.connectionId && calendar.connectionId !== connectionId) {
    throw new Error("Calendar connection does not match this event");
  }
  const providerCalendarId =
    calendar.providerCalendarId ?? calendar.googleCalendarId ?? event.calendarId;
  const providerEventId = event.providerEventId ?? event.googleEventId;
  const providerSeriesId = event.providerSeriesId ?? event.recurringEventId;

  if (
    calendar.connectionId === undefined ||
    calendar.providerCalendarId === undefined
  ) {
    await ctx.db.patch(calendar._id, {
      connectionId,
      providerCalendarId,
    });
  }
  if (
    event.connectionId === undefined ||
    event.localCalendarId === undefined ||
    event.providerEventId === undefined ||
    (event.recurringEventId !== undefined && event.providerSeriesId === undefined) ||
    event.providerUpdatedMs === undefined
  ) {
    await ctx.db.patch(event._id, {
      connectionId,
      localCalendarId: calendar._id,
      providerEventId,
      providerSeriesId,
      providerUpdatedMs: event.providerUpdatedMs ?? event.googleUpdatedMs,
    });
  }
  return {
    event: {
      ...event,
      connectionId,
      localCalendarId: calendar._id,
      providerEventId,
      providerSeriesId,
      providerUpdatedMs: event.providerUpdatedMs ?? event.googleUpdatedMs,
    },
    calendar: {
      ...calendar,
      connectionId,
      providerCalendarId,
    },
    connectionId,
    localCalendarId: calendar._id,
    providerCalendarId,
    providerEventId,
    providerSeriesId,
  };
}

export async function claimCalendarOperationHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    connectionId: Id<"calendarConnections">;
    localCalendarId: Id<"calendars">;
    providerCalendarId: string;
    providerEventId?: string;
    idempotencyKey: string;
    kind: "create" | "update" | "delete" | "respond";
    attemptId: string;
  },
) {
  const connection = await ctx.db.get(args.connectionId);
  const calendar = await ctx.db.get(args.localCalendarId);
  if (
    !connection ||
    connection.userId !== args.userId ||
    !calendar ||
    calendar.userId !== args.userId ||
    calendar.connectionId !== args.connectionId ||
    (calendar.providerCalendarId ?? calendar.googleCalendarId) !==
      args.providerCalendarId
  ) {
    throw new Error("Calendar operation target is invalid");
  }
  const existing = await ctx.db
    .query("calendarOperations")
    .withIndex("by_connection_and_key", (q) =>
      q
        .eq("connectionId", args.connectionId)
        .eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (existing) {
    if (
      existing.userId !== args.userId ||
      existing.kind !== args.kind ||
      (existing.localCalendarId &&
        existing.localCalendarId !== args.localCalendarId) ||
      (existing.providerCalendarId &&
        existing.providerCalendarId !== args.providerCalendarId)
    ) {
      throw new Error("Calendar operation key was already used for another write");
    }
    if (existing.status === "succeeded") {
      return {
        state: "succeeded" as const,
        providerEventId: existing.providerEventId,
      };
    }
    if (
      existing.status === "pending" &&
      existing.attemptId &&
      (existing.leaseExpiresAt ?? 0) > Date.now()
    ) {
      throw new Error("This calendar change is already being applied");
    }
    await ctx.db.patch(existing._id, {
      status: "pending",
      attemptId: args.attemptId,
      leaseExpiresAt: Date.now() + CALENDAR_OPERATION_LEASE_MS,
      mayHaveSucceeded: true,
      localCalendarId: args.localCalendarId,
      providerCalendarId: args.providerCalendarId,
      providerEventId: existing.providerEventId ?? args.providerEventId,
      lastError: undefined,
      updatedAt: Date.now(),
    });
    return {
      state: "claimed" as const,
      reconcileOnly:
        existing.status === "ambiguous" || existing.mayHaveSucceeded === true,
    };
  }
  const now = Date.now();
  await ctx.db.insert("calendarOperations", {
    connectionId: args.connectionId,
    userId: args.userId,
    idempotencyKey: args.idempotencyKey,
    kind: args.kind,
    status: "pending",
    attemptId: args.attemptId,
    leaseExpiresAt: now + CALENDAR_OPERATION_LEASE_MS,
    mayHaveSucceeded: true,
    localCalendarId: args.localCalendarId,
    providerCalendarId: args.providerCalendarId,
    providerEventId: args.providerEventId,
    createdAt: now,
    updatedAt: now,
  });
  return { state: "claimed" as const, reconcileOnly: false };
}

export async function settleCalendarOperationHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    connectionId: Id<"calendarConnections">;
    idempotencyKey: string;
    attemptId: string;
    status: "succeeded" | "ambiguous" | "failed";
    providerEventId?: string;
    error?: string;
  },
): Promise<boolean> {
  const operation = await ctx.db
    .query("calendarOperations")
    .withIndex("by_connection_and_key", (q) =>
      q
        .eq("connectionId", args.connectionId)
        .eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (
    !operation ||
    operation.userId !== args.userId ||
    operation.status !== "pending" ||
    operation.attemptId !== args.attemptId
  ) {
    return false;
  }
  await ctx.db.patch(operation._id, {
    status: args.status,
    attemptId: undefined,
    leaseExpiresAt: undefined,
    mayHaveSucceeded: args.status === "ambiguous" ? true : undefined,
    providerEventId: args.providerEventId ?? operation.providerEventId,
    lastError: args.error,
    updatedAt: Date.now(),
  });
  return true;
}

/** Toggle whether a calendar's events appear on the grid. */
export async function setCalendarSelectedHandler(
  ctx: MutationCtx,
  args: { calendarId: Id<"calendars">; selected: boolean },
): Promise<null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }
  const cal = await ctx.db.get(args.calendarId);
  if (!cal || cal.userId !== user._id) {
    throw new Error("Calendar not found");
  }
  await ctx.db.patch(args.calendarId, { selected: args.selected });
  return null;
}

/** Drop the local row as soon as Google accepts the delete, so the card leaves
 * the grid now rather than whenever the next sync happens to run. */
export async function deleteEventRowHandler(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    userId: string;
    calendarId?: string;
    recurringEventId?: string;
  },
): Promise<null> {
  const row = await ctx.db.get(args.eventId);
  if (row && row.userId === args.userId) {
    await ctx.db.delete(args.eventId);
  }
  if (args.recurringEventId) {
    const series = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q
          .eq("userId", args.userId)
          .eq("calendarId", args.calendarId ?? row?.calendarId ?? "")
          .eq("googleEventId", args.recurringEventId!),
      )
      .unique();
    if (series) await ctx.db.delete(series._id);
  }
  return null;
}

/** Mirror a single event into the synced table (optimistic update after create). */
export async function upsertEventHandler(
  ctx: MutationCtx,
  args: { userId: string; event: Infer<typeof googleEventValidator> },
): Promise<null> {
  // Dual-write: stamp the neutral mirror alongside the Google-named columns so
  // the row stays cutover-ready. Legacy columns remain the source of truth.
  const connectionId = await ensureGoogleConnection(ctx, args.userId);
  const localCalendar = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (q) =>
      q.eq("userId", args.userId).eq("googleCalendarId", args.event.calendarId),
    )
    .unique();
  const doc = {
    userId: args.userId,
    ...args.event,
    connectionId,
    localCalendarId: localCalendar?._id,
    providerEventId: args.event.googleEventId,
    providerUpdatedMs: args.event.googleUpdatedMs,
    providerSeriesId: args.event.recurringEventId,
  };
  const existing = await ctx.db
    .query("events")
    .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
      q
        .eq("userId", args.userId)
        .eq("calendarId", args.event.calendarId)
        .eq("googleEventId", args.event.googleEventId),
    )
    .unique();
  if (existing) {
    await ctx.db.replace(existing._id, doc);
  } else {
    await ctx.db.insert("events", doc);
  }
  return null;
}

/** Store an adapter event while legacy calendar readers still use Google-named
 * columns. This compatibility mapping belongs to storage, not to an integration. */
export async function mirrorProviderEventHandler(
  ctx: MutationCtx,
  args: {
    connectionId: Id<"calendarConnections">;
    localCalendarId: Id<"calendars">;
    event: Infer<typeof providerEventValidator>;
  },
): Promise<null> {
  const connection = await ctx.db.get(args.connectionId);
  const calendar = await ctx.db.get(args.localCalendarId);
  if (
    !connection ||
    !calendar ||
    calendar.userId !== connection.userId ||
    (calendar.connectionId !== undefined &&
      calendar.connectionId !== connection._id) ||
    (calendar.providerCalendarId ?? calendar.googleCalendarId) !==
      args.event.calendarId
  ) {
    throw new Error("Calendar event mirror target is invalid");
  }

  const event = args.event;
  const legacyEvent: Omit<Doc<"events">, "_id" | "_creationTime"> = {
    userId: connection.userId,
    googleEventId: event.id,
    calendarId: calendar.googleCalendarId,
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
      event.busy === undefined
        ? undefined
        : event.busy
          ? "opaque"
          : "transparent",
    attendees: event.attendees
      ?.filter((attendee) => attendee.email !== undefined)
      .map((attendee) => ({
        email: attendee.email!,
        displayName: attendee.displayName,
        responseStatus: attendee.responseStatus,
        organizer: attendee.organizer,
        self: attendee.self,
        optional: attendee.optional,
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
      event.conference?.type === "hangoutsMeet"
        ? event.conference.url
        : undefined,
    conferenceUrl: event.conference?.url,
    conferenceName: event.conference?.name,
    conferenceType: event.conference?.type,
    connectionId: connection._id,
    localCalendarId: calendar._id,
    providerEventId: event.id,
    providerUpdatedMs: event.updatedMs,
    providerSeriesId: event.seriesId,
  };
  const existing = await ctx.db
    .query("events")
    .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
      q
        .eq("userId", connection.userId)
        .eq("calendarId", calendar.googleCalendarId)
        .eq("googleEventId", event.id),
    )
    .unique();
  if (existing) await ctx.db.replace(existing._id, legacyEvent);
  else await ctx.db.insert("events", legacyEvent);
  return null;
}

/** Remove an optimistic event row and, for a whole-series write, its rule cache. */
export async function deleteProviderEventMirrorHandler(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    userId: string;
    connectionId: Id<"calendarConnections">;
    localCalendarId: Id<"calendars">;
    providerSeriesId?: string;
  },
): Promise<null> {
  const row = await ctx.db.get(args.eventId);
  if (
    row?.userId === args.userId &&
    row.connectionId === args.connectionId &&
    row.localCalendarId === args.localCalendarId
  ) {
    await ctx.db.delete(row._id);
  }
  if (args.providerSeriesId) {
    const calendar = await ctx.db.get(args.localCalendarId);
    if (calendar?.userId === args.userId) {
      const series = await ctx.db
        .query("recurringSeries")
        .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
          q
            .eq("userId", args.userId)
            .eq("calendarId", calendar.googleCalendarId)
            .eq("googleEventId", args.providerSeriesId!),
        )
        .unique();
      if (series) await ctx.db.delete(series._id);
    }
  }
  return null;
}

/** Cache a recurring master by neutral identity while dual-writing legacy keys. */
export async function upsertProviderRecurringSeriesHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    connectionId: Id<"calendarConnections">;
    localCalendarId: Id<"calendars">;
    providerEventId: string;
    recurrence: string[];
    sourceUpdatedMs: number;
    replacedEventId?: Id<"events">;
  },
): Promise<null> {
  const connection = await ctx.db.get(args.connectionId);
  const calendar = await ctx.db.get(args.localCalendarId);
  if (
    !connection ||
    connection.userId !== args.userId ||
    !calendar ||
    calendar.userId !== args.userId ||
    calendar.connectionId !== args.connectionId
  ) {
    throw new Error("Recurring series target is invalid");
  }
  const existing = await ctx.db
    .query("recurringSeries")
    .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
      q
        .eq("userId", args.userId)
        .eq("calendarId", calendar.googleCalendarId)
        .eq("googleEventId", args.providerEventId),
    )
    .unique();
  const value = {
    recurrence: args.recurrence,
    sourceUpdatedMs: args.sourceUpdatedMs,
    connectionId: args.connectionId,
    localCalendarId: args.localCalendarId,
    providerEventId: args.providerEventId,
    providerSeriesId: args.providerEventId,
    providerUpdatedMs: args.sourceUpdatedMs,
  };
  if (existing) await ctx.db.patch(existing._id, value);
  else {
    await ctx.db.insert("recurringSeries", {
      userId: args.userId,
      calendarId: calendar.googleCalendarId,
      googleEventId: args.providerEventId,
      ...value,
    });
  }
  if (args.replacedEventId) {
    const replaced = await ctx.db.get(args.replacedEventId);
    if (
      replaced?.userId === args.userId &&
      replaced.connectionId === args.connectionId &&
      replaced.localCalendarId === args.localCalendarId &&
      (replaced.providerEventId ?? replaced.googleEventId) === args.providerEventId
    ) {
      await ctx.db.delete(replaced._id);
    }
  }
  return null;
}

/** Cache one recurring master's rule for all of its expanded instances. */
export async function upsertRecurringSeriesHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    calendarId: string;
    googleEventId: string;
    recurrence: string[];
    sourceUpdatedMs: number;
    replacedEventId?: Id<"events">;
  },
): Promise<null> {
  const existing = await ctx.db
    .query("recurringSeries")
    .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
      q
        .eq("userId", args.userId)
        .eq("calendarId", args.calendarId)
        .eq("googleEventId", args.googleEventId),
    )
    .unique();
  // Dual-write the neutral mirror (connectionId + providerEventId) on both the
  // patch and insert paths, so incremental cache refreshes keep it current too.
  const connectionId = await ensureGoogleConnection(ctx, args.userId);
  const localCalendar = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (q) =>
      q.eq("userId", args.userId).eq("googleCalendarId", args.calendarId),
    )
    .unique();
  const value = {
    recurrence: args.recurrence,
    sourceUpdatedMs: args.sourceUpdatedMs,
    connectionId,
    localCalendarId: localCalendar?._id,
    providerEventId: args.googleEventId,
    providerSeriesId: args.googleEventId,
    providerUpdatedMs: args.sourceUpdatedMs,
  };
  if (existing) {
    await ctx.db.patch(existing._id, value);
  } else {
    await ctx.db.insert("recurringSeries", {
      userId: args.userId,
      calendarId: args.calendarId,
      googleEventId: args.googleEventId,
      ...value,
    });
  }
  if (args.replacedEventId) {
    const replaced = await ctx.db.get(args.replacedEventId);
    if (
      replaced?.userId === args.userId &&
      replaced.calendarId === args.calendarId &&
      replaced.googleEventId === args.googleEventId
    ) {
      await ctx.db.delete(args.replacedEventId);
    }
  }
  return null;
}
