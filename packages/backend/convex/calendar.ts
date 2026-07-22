import { v } from "convex/values";

import { internal } from "./_generated/api";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { CALENDAR_HISTORY_MS, syncOneCalendar } from "./googleSync";
import { attendeeValidator } from "./schema";
import {
  insertCalendarEvent,
  type MappedEvent,
  patchCalendarEvent,
} from "./lib/google";

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

    const toGoogleTime = (ms: number) =>
      args.allDay
        ? { date: new Date(ms).toISOString().slice(0, 10) }
        : { dateTime: new Date(ms).toISOString(), timeZone: args.timeZone };

    const hasGuests = Boolean(args.attendees && args.attendees.length > 0);
    const event = await insertCalendarEvent(
      accessToken,
      targetCalendarId,
      {
        summary: args.summary,
        description: args.description,
        location: args.location,
        start: toGoogleTime(args.startMs),
        end: toGoogleTime(args.endMs),
        colorId: args.colorId,
        visibility: args.visibility,
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

/** The synced row for an event, used by actions (which can't read the db). */
export const getEvent = internalQuery({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }) => {
    return await ctx.db.get(eventId);
  },
});

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
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }

    const row = await ctx.runQuery(internal.calendar.getEvent, {
      eventId: args.eventId,
    });
    if (!row || row.userId !== user._id) {
      throw new Error("Event not found");
    }

    const { accessToken } = await createAuth(ctx).api.getAccessToken({
      body: { providerId: "google", userId: user._id },
    });
    if (!accessToken) {
      throw new Error("No Google access token available for user");
    }

    const toGoogleTime = (ms: number) =>
      row.allDay
        ? { date: new Date(ms).toISOString().slice(0, 10) }
        : { dateTime: new Date(ms).toISOString(), timeZone: args.timeZone };

    const event = await patchCalendarEvent(
      accessToken,
      row.calendarId,
      row.googleEventId,
      { start: toGoogleTime(args.startMs), end: toGoogleTime(args.endMs) },
    );

    await ctx.runMutation(internal.calendar.upsertEvent, {
      userId: user._id,
      event,
    });
    return event;
  },
});

/** Edit an existing event's content (summary / description): patch Google, then
 * mirror the result locally. Modeled on updateEventTime — same ownership check,
 * token fetch, and optimistic upsert — but touches content fields rather than
 * times. The description is stored as the HTML subset Google keeps. */
export const updateEvent = action({
  args: {
    eventId: v.id("events"),
    summary: v.optional(v.string()),
    /** HTML description (bold/italic/underline/links/lists). Empty string clears it. */
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<MappedEvent> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }

    const row = await ctx.runQuery(internal.calendar.getEvent, {
      eventId: args.eventId,
    });
    if (!row || row.userId !== user._id) {
      throw new Error("Event not found");
    }

    const { accessToken } = await createAuth(ctx).api.getAccessToken({
      body: { providerId: "google", userId: user._id },
    });
    if (!accessToken) {
      throw new Error("No Google access token available for user");
    }

    const event = await patchCalendarEvent(
      accessToken,
      row.calendarId,
      row.googleEventId,
      { summary: args.summary, description: args.description },
    );

    await ctx.runMutation(internal.calendar.upsertEvent, {
      userId: user._id,
      event,
    });
    return event;
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
  args: {
    userId: v.string(),
    event: v.object({
      googleEventId: v.string(),
      calendarId: v.string(),
      summary: v.optional(v.string()),
      description: v.optional(v.string()),
      location: v.optional(v.string()),
      startMs: v.number(),
      endMs: v.number(),
      allDay: v.boolean(),
      status: v.string(),
      htmlLink: v.optional(v.string()),
      colorId: v.optional(v.string()),
      visibility: v.optional(v.string()),
      attendees: v.optional(v.array(attendeeValidator)),
      googleUpdatedMs: v.number(),
    }),
  },
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
