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
import { insertCalendarEvent, type MappedEvent } from "./lib/google";

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

    // Write to (and stamp the mirrored row with) the real primary calendar id,
    // so the optimistic row matches what the next sync produces. Falls back to
    // the "primary" keyword if the calendar list hasn't synced yet.
    const primaryCalendarId: string =
      (await ctx.runQuery(internal.calendar.getPrimaryCalendarId, {
        userId: user._id,
      })) ?? "primary";

    const toGoogleTime = (ms: number) =>
      args.allDay
        ? { date: new Date(ms).toISOString().slice(0, 10) }
        : { dateTime: new Date(ms).toISOString() };

    const event = await insertCalendarEvent(accessToken, primaryCalendarId, {
      summary: args.summary,
      description: args.description,
      location: args.location,
      start: toGoogleTime(args.startMs),
      end: toGoogleTime(args.endMs),
    });

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
