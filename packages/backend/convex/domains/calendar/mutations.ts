/** Write handlers for the calendar domain that stay on our side (no Google):
 * the visibility toggle and the optimistic-mirror internal mutations. Plain
 * functions; the root `calendar.ts` wraps each in a Convex mutation. */

import type { Infer } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import { ensureGoogleConnection } from "./connections";
import { googleEventValidator, providerEventValidator } from "./validators";

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
