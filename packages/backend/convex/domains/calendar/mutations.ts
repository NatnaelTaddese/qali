/** Write side of the calendar domain that stays local (no provider calls):
 * the visibility toggle and the optimistic-mirror internal mutations.
 * Registration is canonical here, under `api.domains.calendar.mutations.*` /
 * `internal.domains.calendar.mutations.*`. */

import { v, type Infer } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  ensureDefaultPrimaryCalendar,
  ensureGoogleConnection,
} from "./connections";
import { providerEventValidator } from "./validators";

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

/** Resolve an owned local calendar row to a writable provider target. */
export async function resolveCreateTargetHandler(
  ctx: MutationCtx,
  args: { userId: string; requestedCalendarId?: Id<"calendars"> },
) {
  let calendar = args.requestedCalendarId
    ? await ctx.db.get(args.requestedCalendarId)
    : null;
  if (calendar && calendar.userId !== args.userId) {
    throw new Error("Calendar not found");
  }
  if (!calendar && args.requestedCalendarId) {
    throw new Error("Calendar not found");
  }
  if (!calendar) {
    const calendars = await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(501);
    if (calendars.length > 500) {
      throw new Error("Too many calendars to choose a write target safely");
    }
    calendar = calendars.find((row) => row.primary) ?? null;
  }
  if (!calendar && !args.requestedCalendarId) {
    const connectionId = await ensureGoogleConnection(ctx, args.userId);
    calendar = await ensureDefaultPrimaryCalendar(
      ctx,
      args.userId,
      connectionId,
    );
  }
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

export const resolveCreateTarget = internalMutation({
  args: {
    userId: v.string(),
    requestedCalendarId: v.optional(v.id("calendars")),
  },
  handler: (ctx, args) => resolveCreateTargetHandler(ctx, args),
});

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

export const resolveEventWriteTarget = internalMutation({
  args: { userId: v.string(), eventId: v.id("events") },
  handler: (ctx, args) => resolveEventWriteTargetHandler(ctx, args),
});

export async function claimCalendarOperationHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    connectionId: Id<"calendarConnections">;
    localCalendarId: Id<"calendars">;
    providerCalendarId: string;
    providerEventId?: string;
    targetEventId?: Id<"events">;
    targetProviderEventId?: string;
    requestFingerprint: string;
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
        existing.providerCalendarId !== args.providerCalendarId) ||
      (existing.targetEventId &&
        existing.targetEventId !== args.targetEventId) ||
      (existing.targetProviderEventId &&
        existing.targetProviderEventId !== args.targetProviderEventId) ||
      (!existing.targetProviderEventId &&
        existing.kind !== "create" &&
        existing.providerEventId !== undefined &&
        existing.providerEventId !== args.targetProviderEventId) ||
      (existing.requestFingerprint &&
        existing.requestFingerprint !== args.requestFingerprint)
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
      targetEventId: existing.targetEventId ?? args.targetEventId,
      targetProviderEventId:
        existing.targetProviderEventId ?? args.targetProviderEventId,
      requestFingerprint:
        existing.requestFingerprint ?? args.requestFingerprint,
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
    targetEventId: args.targetEventId,
    targetProviderEventId: args.targetProviderEventId,
    requestFingerprint: args.requestFingerprint,
    providerEventId: args.providerEventId,
    createdAt: now,
    updatedAt: now,
  });
  return { state: "claimed" as const, reconcileOnly: false };
}

export const claimCalendarOperation = internalMutation({
  args: {
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    localCalendarId: v.id("calendars"),
    providerCalendarId: v.string(),
    providerEventId: v.optional(v.string()),
    targetEventId: v.optional(v.id("events")),
    targetProviderEventId: v.optional(v.string()),
    requestFingerprint: v.string(),
    idempotencyKey: v.string(),
    kind: v.union(
      v.literal("create"),
      v.literal("update"),
      v.literal("delete"),
      v.literal("respond"),
    ),
    attemptId: v.string(),
  },
  handler: (ctx, args) => claimCalendarOperationHandler(ctx, args),
});

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

export const settleCalendarOperation = internalMutation({
  args: {
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    idempotencyKey: v.string(),
    attemptId: v.string(),
    status: v.union(
      v.literal("succeeded"),
      v.literal("ambiguous"),
      v.literal("failed"),
    ),
    providerEventId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: (ctx, args) => settleCalendarOperationHandler(ctx, args),
});

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

export const setCalendarSelected = mutation({
  args: { calendarId: v.id("calendars"), selected: v.boolean() },
  handler: (ctx, args) => setCalendarSelectedHandler(ctx, args),
});

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
    color: event.color,
    busy: event.busy,
  };
  const legacyCandidates = await ctx.db
      .query("events")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q
          .eq("userId", connection.userId)
          .eq("calendarId", calendar.googleCalendarId)
          .eq("googleEventId", event.id),
      )
      .collect();
  const existing = legacyCandidates.find(
      (row) =>
        (row.connectionId === undefined ||
          row.connectionId === connection._id) &&
        (row.localCalendarId === undefined || row.localCalendarId === calendar._id),
    );
  if (existing) await ctx.db.replace(existing._id, legacyEvent);
  else await ctx.db.insert("events", legacyEvent);
  return null;
}

export const mirrorProviderEvent = internalMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    localCalendarId: v.id("calendars"),
    event: providerEventValidator,
  },
  handler: (ctx, args) => mirrorProviderEventHandler(ctx, args),
});

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

export const deleteProviderEventMirror = internalMutation({
  args: {
    eventId: v.id("events"),
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    localCalendarId: v.id("calendars"),
    providerSeriesId: v.optional(v.string()),
  },
  handler: (ctx, args) => deleteProviderEventMirrorHandler(ctx, args),
});

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
  const legacyCandidates = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q
          .eq("userId", args.userId)
          .eq("calendarId", calendar.googleCalendarId)
          .eq("googleEventId", args.providerEventId),
      )
      .collect();
  const existing = legacyCandidates.find(
      (row) =>
        (row.connectionId === undefined ||
          row.connectionId === args.connectionId) &&
        (row.localCalendarId === undefined ||
          row.localCalendarId === args.localCalendarId),
    );
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

export const upsertProviderRecurringSeries = internalMutation({
  args: {
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    localCalendarId: v.id("calendars"),
    providerEventId: v.string(),
    recurrence: v.array(v.string()),
    sourceUpdatedMs: v.number(),
    replacedEventId: v.optional(v.id("events")),
  },
  handler: (ctx, args) => upsertProviderRecurringSeriesHandler(ctx, args),
});
