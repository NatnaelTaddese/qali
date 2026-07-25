import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { CALENDAR_HISTORY_MS, syncOneCalendar } from "./googleSync";
import { googleEventValidator } from "./schema";
import {
  deleteCalendarEvent,
  getCalendarEvent,
  insertCalendarEvent,
  type MappedEvent,
  patchCalendarEvent,
  toGoogleTime,
} from "./lib/google";
import {
  eventCapabilities,
  type EventCapabilities,
} from "./lib/permissions";

/** The set of `googleCalendarId`s the user has toggled visible. */
async function selectedCalendarIds(
  ctx: QueryCtx,
  userId: string,
): Promise<Set<string>> {
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return new Set(
    calendars.filter((c) => c.selected).map((c) => c.googleCalendarId),
  );
}

/** The user's connected calendars, for the visibility list in the header. */
export const listCalendars = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    return await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
  },
});

/** Toggle whether a calendar's events appear on the grid. */
export const setCalendarSelected = mutation({
  args: { calendarId: v.id("calendars"), selected: v.boolean() },
  handler: async (ctx, args): Promise<null> => {
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
  },
});

/** Upcoming events for the current user, read from the synced `events` table. */
export const listEvents = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    const selected = await selectedCalendarIds(ctx, user._id);
    const now = Date.now();
    const rows = await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) =>
        q.eq("userId", user._id).gte("startMs", now),
      )
      .order("asc")
      .take(50);
    return rows.filter((e) => selected.has(e.calendarId));
  },
});

/** Events overlapping [startMs, endMs) for the current user, e.g. a week window. */
export const listEventsInRange = query({
  args: { startMs: v.number(), endMs: v.number() },
  handler: async (ctx, { startMs, endMs }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    const selected = await selectedCalendarIds(ctx, user._id);
    // The index is on startMs, so scan back a day to catch events that begin
    // before the window but overlap into it. Timed events longer than 24h that
    // start earlier than the lookback are an accepted limitation.
    const LOOKBACK_MS = 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) =>
        q
          .eq("userId", user._id)
          .gte("startMs", startMs - LOOKBACK_MS)
          .lt("startMs", endMs),
      )
      .order("asc")
      .collect();
    return rows.filter(
      (e) =>
        e.endMs > startMs &&
        e.status !== "cancelled" &&
        selected.has(e.calendarId),
    );
  },
});

/** One event, live.
 *
 * The detail panel opens from a snapshot held in dock state, which is stale the
 * moment anything mutates the event. Subscribing here means an edit or an RSVP
 * shows up in the open panel instead of only after closing and reopening it. */
export const getEventById = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return null;
    }
    const row = await ctx.db.get(eventId);
    return row && row.userId === user._id ? row : null;
  },
});

/** Create a calendar event in Google, then mirror it into the synced table. */
export const createEvent = action({
  args: {
    summary: v.string(),
    startMs: v.number(),
    endMs: v.number(),
    description: v.optional(v.string()),
    location: v.optional(v.string()),
    allDay: v.optional(v.boolean()),
    /** Google calendar to create in; defaults to the user's primary. */
    calendarId: v.optional(v.string()),
    /** Google event colour override ("1".."11"); absent inherits the calendar. */
    colorId: v.optional(v.string()),
    visibility: v.optional(v.string()),
    /** Google's `transparency`: "transparent" (free); absent = busy (the default). */
    transparency: v.optional(v.string()),
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
  },
  handler: async (ctx, args): Promise<MappedEvent> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }

    const { accessToken } = await createAuth(ctx).api.getAccessToken({
      body: { providerId: "google", userId: user._id },
    });
    if (!accessToken) {
      throw new Error("No Google access token available for user");
    }

    // Write to (and stamp the mirrored row with) a real calendar id, so the
    // optimistic row matches what the next sync produces. Without an explicit
    // choice that's the user's primary, falling back to the "primary" keyword
    // if the calendar list hasn't synced yet.
    const targetCalendarId: string =
      args.calendarId ??
      (await ctx.runQuery(internal.calendar.getPrimaryCalendarId, {
        userId: user._id,
      })) ??
      "primary";

    const allDay = args.allDay ?? false;
    const hasGuests = Boolean(args.attendees && args.attendees.length > 0);
    const event = await insertCalendarEvent(
      accessToken,
      targetCalendarId,
      {
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
    );

    if (args.recurrence && args.recurrence.length > 0) {
      // A recurring event is stored by Google as a hidden "master"; our sync
      // reads with singleEvents=true, so it only ever sees the *expanded*
      // instances (each a distinct googleEventId), never the master. Mirroring
      // `event` (the master) would leave an orphan row that no later sync
      // touches. Instead pull the freshly expanded instances in now.
      const calendars = await ctx.runQuery(
        internal.googleSync.listCalendarsForUser,
        { userId: user._id },
      );
      const cal = calendars.find(
        (c) => c.googleCalendarId === targetCalendarId,
      );
      if (cal) {
        await syncOneCalendar(ctx, user._id, accessToken, cal, Date.now() - CALENDAR_HISTORY_MS);
      }
      return event;
    }

    await ctx.runMutation(internal.calendar.upsertEvent, {
      userId: user._id,
      event,
    });
    return event;
  },
});

/** An event plus the calendar it lives on — everything `eventCapabilities`
 * needs, in one round trip. The join is on the Google id, since `events` stores
 * its calendar as that string rather than as a document reference. */
export const getEventContext = internalQuery({
  args: { eventId: v.id("events"), userId: v.string() },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event || event.userId !== args.userId) {
      return null;
    }
    const calendar = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q.eq("userId", args.userId).eq("googleCalendarId", event.calendarId),
      )
      .unique();
    return { event, calendar };
  },
});

type EventCapabilityName =
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

/**
 * The opening move of every action that writes to an event: resolve the user,
 * load the event with its calendar, check that at least one of `allowed` holds,
 * and fetch a Google token.
 *
 * Owning the row is not the same as being allowed to change it — sync copies
 * every calendar the user can *see*, holidays and read-only shares included —
 * so the capability check is the real gate here and Google's 403 is only a
 * backstop. Without it a refusal arrives after the optimistic UI has moved.
 */
async function authorizeEventAction(
  ctx: ActionCtx,
  eventId: Id<"events">,
  allowed: EventCapabilityName[],
): Promise<{
  userId: string;
  row: Doc<"events">;
  capabilities: EventCapabilities;
  accessToken: string;
}> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }

  const context = await ctx.runQuery(internal.calendar.getEventContext, {
    eventId,
    userId: user._id,
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

  const { accessToken } = await createAuth(ctx).api.getAccessToken({
    body: { providerId: "google", userId: user._id },
  });
  if (!accessToken) {
    throw new Error("No Google access token available for user");
  }

  return { userId: user._id, row: context.event, capabilities, accessToken };
}

/** Reschedule an existing event: patch Google, then mirror the new times
 * locally. The frontend calls this on drag/resize; it holds an optimistic
 * override until this returns and the next sync reflects the change. */
export const updateEventTime = action({
  args: {
    eventId: v.id("events"),
    startMs: v.number(),
    endMs: v.number(),
    /** Client IANA time zone; Google needs it to anchor a timed instant. */
    timeZone: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<MappedEvent> => {
    const { userId, row, accessToken } = await authorizeEventAction(
      ctx,
      args.eventId,
      ["canEdit"],
    );

    const event = await patchCalendarEvent(
      accessToken,
      row.calendarId,
      row.googleEventId,
      {
        start: toGoogleTime(args.startMs, row.allDay, args.timeZone),
        end: toGoogleTime(args.endMs, row.allDay, args.timeZone),
      },
    );

    await ctx.runMutation(internal.calendar.upsertEvent, { userId, event });
    return event;
  },
});

/**
 * Edit an existing event: patch Google, then mirror the result locally.
 *
 * Every field is optional and only the ones present are sent, so a caller can
 * patch exactly what the user touched. Fields that can be *emptied* take an
 * explicit `null` for that, because Google reads an omitted field as "leave
 * alone" — sending `""` would store an empty string rather than clear it.
 */
export const updateEvent = action({
  args: {
    eventId: v.id("events"),
    summary: v.optional(v.string()),
    /** HTML description (bold/italic/underline/links/lists). `null` clears it. */
    description: v.optional(v.union(v.string(), v.null())),
    location: v.optional(v.union(v.string(), v.null())),
    /** Google event colour ("1".."11"); `null` reverts to the calendar's. */
    colorId: v.optional(v.union(v.string(), v.null())),
    visibility: v.optional(v.union(v.string(), v.null())),
    /** Google's `transparency`: "opaque" (busy) | "transparent" (free). */
    transparency: v.optional(v.string()),
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
          responseStatus: v.optional(v.string()),
          optional: v.optional(v.boolean()),
        }),
      ),
    ),
    /** Client IANA time zone; Google needs it to anchor a timed instant. */
    timeZone: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<MappedEvent> => {
    const { userId, row, accessToken } = await authorizeEventAction(
      ctx,
      args.eventId,
      ["canEdit"],
    );

    // Falling back to the stored value keeps a times-only patch rendering the
    // same kind of event it already was.
    const allDay = args.allDay ?? row.allDay;
    const times =
      args.startMs !== undefined && args.endMs !== undefined
        ? {
            start: toGoogleTime(args.startMs, allDay, args.timeZone),
            end: toGoogleTime(args.endMs, allDay, args.timeZone),
          }
        : {};

    const event = await patchCalendarEvent(
      accessToken,
      row.calendarId,
      row.googleEventId,
      {
        ...times,
        summary: args.summary,
        description: args.description,
        location: args.location,
        colorId: args.colorId,
        visibility: args.visibility,
        transparency: args.transparency,
        attendees: args.attendees,
      },
      // Only bother the guests when the guest list itself changed.
      args.attendees ? "all" : undefined,
    );

    await ctx.runMutation(internal.calendar.upsertEvent, { userId, event });
    return event;
  },
});

/**
 * Answer an invitation.
 *
 * Google has no RSVP endpoint — you patch the event's `attendees`, and a patch
 * *replaces* that array wholesale. So this reads Google's own copy first rather
 * than rebuilding the list from our rows: we store a subset of each attendee,
 * and sending that subset back would strip comments, extra guests and room
 * resources from the event for everyone on it.
 */
export const respondToEvent = action({
  args: {
    eventId: v.id("events"),
    responseStatus: v.union(
      v.literal("accepted"),
      v.literal("tentative"),
      v.literal("declined"),
    ),
  },
  handler: async (ctx, args): Promise<MappedEvent> => {
    const { userId, row, capabilities, accessToken } =
      await authorizeEventAction(ctx, args.eventId, ["canRespond"]);

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

    await ctx.runMutation(internal.calendar.upsertEvent, { userId, event });
    return event;
  },
});

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
export const deleteEvent = action({
  args: { eventId: v.id("events") },
  handler: async (ctx, args): Promise<null> => {
    const { userId, row, capabilities, accessToken } =
      await authorizeEventAction(ctx, args.eventId, [
        "canDelete",
        "canRemoveSelf",
      ]);

    const hasGuests = (row.attendees?.length ?? 0) > 0;
    await deleteCalendarEvent(
      accessToken,
      row.calendarId,
      row.googleEventId,
      // Only the organizer's delete is a cancellation worth emailing about.
      capabilities.isOrganizer && hasGuests ? "all" : "none",
    );

    await ctx.runMutation(internal.calendar.deleteEventRow, {
      eventId: args.eventId,
      userId,
    });
    return null;
  },
});

/** Drop the local row as soon as Google accepts the delete, so the card leaves
 * the grid now rather than whenever the next sync happens to run. */
export const deleteEventRow = internalMutation({
  args: { eventId: v.id("events"), userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.eventId);
    if (row && row.userId === args.userId) {
      await ctx.db.delete(args.eventId);
    }
    return null;
  },
});

/** Resolve the user's primary calendar id (the email), if it has synced. */
export const getPrimaryCalendarId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const calendars = await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return calendars.find((c) => c.primary)?.googleCalendarId ?? null;
  },
});

/** Mirror a single event into the synced table (optimistic update after create). */
export const upsertEvent = internalMutation({
  args: { userId: v.string(), event: googleEventValidator },
  handler: async (ctx, args): Promise<null> => {
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
      await ctx.db.patch(existing._id, args.event);
    } else {
      await ctx.db.insert("events", { userId: args.userId, ...args.event });
    }
    return null;
  },
});
