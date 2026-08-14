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
import { authComponent } from "./auth";
import { isSharedPublicCalendar } from "./lib/calendars";
import {
  MAX_EVENT_SPAN_MS,
  newRowBudget,
  type RowBudget,
  spendRowBudget,
} from "./lib/eventReads";
import { googleEventValidator } from "./schema";
import { getCalendarEvent, type MappedEvent } from "./lib/google";
import {
  createEventOp,
  deleteEventOp,
  respondToEventOp,
  updateEventOp,
  updateEventTimeOp,
} from "./lib/calendarOps";
import { getGoogleAccessToken } from "./lib/googleCredentials";

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

/**
 * A calendar event as the client sees it: either a synced `events` row or a
 * public `sharedEvents` row (holidays, birthdays) presented in the same shape.
 *
 * The id is honestly the union of both tables rather than a cast to `Id<"events">`.
 * A shared row is read-only, so its `Id<"sharedEvents">` must never be handed to
 * an events-only mutation — the union makes the compiler enforce what the old
 * `as unknown as Doc<"events">` cast silently defeated. The read queries that do
 * accept a shared id already validate `v.union(v.id("events"), v.id("sharedEvents"))`.
 */
export type EventView = Omit<Doc<"events">, "_id"> & {
  _id: Id<"events"> | Id<"sharedEvents">;
};

/** Present a shared (public-calendar) row in the unified {@link EventView} shape.
 * `sharedEvents` has every field `events` does except `userId` (stamped here to
 * the reader) and the id brand — so no cast is needed. */
function sharedAsEvent(row: Doc<"sharedEvents">, userId: string): EventView {
  return { ...row, userId };
}

/** Selected public calendars' events overlapping [fromMs, toMs). These live once
 * in `sharedEvents` (not per-user), so we read them by calendar id and merge into
 * the caller's own events. Cancelled shared events are never stored.
 *
 * Ranged on `endMs` (not `startMs`) so a multi-day holiday that began before the
 * window is still returned; the far side is bounded by `MAX_EVENT_SPAN_MS` and the
 * combined row `budget` guards against a pathological range. */
async function readSharedEventsInRange(
  ctx: QueryCtx,
  userId: string,
  publicCalendarIds: string[],
  fromMs: number,
  toMs: number,
  budget: RowBudget,
): Promise<EventView[]> {
  const spanEnd = toMs + MAX_EVENT_SPAN_MS;
  const out: EventView[] = [];
  for (const calendarId of publicCalendarIds) {
    const page = await ctx.db
      .query("sharedEvents")
      .withIndex("by_calendar_and_end", (q) =>
        q.eq("calendarId", calendarId).gt("endMs", fromMs).lte("endMs", spanEnd),
      )
      .take(budget.remaining + 1);
    spendRowBudget(budget, page.length);
    for (const r of page) {
      if (r.startMs < toMs) out.push(sharedAsEvent(r, userId));
    }
  }
  return out;
}

/** The assistant's view of shared public-calendar (holiday/birthday) events in a
 * range, for the selected calendars. Mirrors `listEventsForAssistant` but over
 * `sharedEvents`; the assistant merges these with the user's own events so it can
 * answer "is that a holiday?" and see holidays when checking a day. Normalized to
 * the events shape (with an `eventId` the assistant can echo back). */
export const listSharedEventsForAssistant = internalQuery({
  args: { userId: v.string(), startMs: v.number(), endMs: v.number() },
  handler: async (ctx, args): Promise<EventView[]> => {
    const calendars = await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const publicIds = calendars
      .filter((c) => c.selected && isSharedPublicCalendar(c.googleCalendarId))
      .map((c) => c.googleCalendarId);

    const out: EventView[] = [];
    for (const calendarId of publicIds) {
      const rows = await ctx.db
        .query("sharedEvents")
        .withIndex("by_calendar_and_end", (q) =>
          q.eq("calendarId", calendarId).gt("endMs", args.startMs),
        )
        .take(ASSISTANT_SHARED_EVENT_LIMIT);
      for (const r of rows) {
        if (r.startMs < args.endMs) out.push(sharedAsEvent(r, args.userId));
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  },
});

// Public calendars are small (a year of holidays is well under this), so a flat
// cap per calendar is enough to stay bounded without a density error.
const ASSISTANT_SHARED_EVENT_LIMIT = 400;

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
    const personal = (
      await ctx.db
        .query("events")
        .withIndex("by_user_and_start", (q) =>
          q.eq("userId", user._id).gte("startMs", now),
        )
        .order("asc")
        .take(50)
    ).filter((e) => selected.has(e.calendarId));
    const publicIds = [...selected].filter(isSharedPublicCalendar);
    const shared: EventView[] = [];
    for (const calendarId of publicIds) {
      const rows = await ctx.db
        .query("sharedEvents")
        .withIndex("by_calendar_and_start", (q) =>
          q.eq("calendarId", calendarId).gte("startMs", now),
        )
        .order("asc")
        .take(50);
      shared.push(...rows.map((r) => sharedAsEvent(r, user._id)));
    }
    return [...personal, ...shared]
      .sort((a, b) => a.startMs - b.startMs)
      .slice(0, 50);
  },
});

// The window is caller-supplied, so bound it: the widest legitimate view (a
// 7-month month-grid, see QUERY_SIDE_MONTHS on the client) is ~214 days, so 400
// days leaves headroom while stopping a forged range from scanning years of rows
// in one unpaginated read.
const MAX_EVENT_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

/** Events overlapping [startMs, endMs) for the current user, e.g. a week window. */
export const listEventsInRange = query({
  args: { startMs: v.number(), endMs: v.number() },
  handler: async (ctx, { startMs, endMs }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    if (endMs <= startMs || endMs - startMs > MAX_EVENT_RANGE_MS) {
      throw new Error("Requested calendar range is too large");
    }
    const selected = await selectedCalendarIds(ctx, user._id);
    // Overlap is `endMs > startMs && startMs < endMs`. Range each calendar's
    // `by_..._end` index on endMs so a multi-day event that began before the
    // window is caught (the old startMs lookback missed those), bound the far
    // side with MAX_EVENT_SPAN_MS, and cap the combined read with one row budget.
    const budget = newRowBudget();
    const spanEnd = endMs + MAX_EVENT_SPAN_MS;
    const personalIds = [...selected].filter((id) => !isSharedPublicCalendar(id));
    const publicIds = [...selected].filter(isSharedPublicCalendar);
    const personal: EventView[] = [];
    for (const calendarId of personalIds) {
      const page = await ctx.db
        .query("events")
        .withIndex("by_user_and_calendar_and_end", (q) =>
          q
            .eq("userId", user._id)
            .eq("calendarId", calendarId)
            .gt("endMs", startMs)
            .lte("endMs", spanEnd),
        )
        .take(budget.remaining + 1);
      spendRowBudget(budget, page.length);
      for (const e of page) {
        if (e.startMs < endMs && e.status !== "cancelled") personal.push(e);
      }
    }
    const shared = await readSharedEventsInRange(
      ctx,
      user._id,
      publicIds,
      startMs,
      endMs,
      budget,
    );
    return [...personal, ...shared].sort((a, b) => a.startMs - b.startMs);
  },
});

/** One event, live.
 *
 * The detail panel opens from a snapshot held in dock state, which is stale the
 * moment anything mutates the event. Subscribing here means an edit or an RSVP
 * shows up in the open panel instead of only after closing and reopening it. */
export const getEventById = query({
  args: { eventId: v.union(v.id("events"), v.id("sharedEvents")) },
  handler: async (ctx, { eventId }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return null;
    }
    const row = await ctx.db.get(eventId);
    if (!row) {
      return null;
    }
    // A personal event is guarded by ownership.
    if ("userId" in row) {
      return row.userId === user._id ? row : null;
    }
    // A shared (public-calendar) event belongs to no user, but it must only be
    // returned to a caller who actually has that calendar selected — otherwise
    // any authenticated user could read any sharedEvents row by guessing its id.
    // We gate on the same selected-calendar set the range reads use.
    const selected = await selectedCalendarIds(ctx, user._id);
    if (!selected.has(row.calendarId)) {
      return null;
    }
    return sharedAsEvent(row, user._id);
  },
});

/** The cached rule for an expanded recurring instance. `null` is a cache miss
 * (or stale cache); the client can ask refreshEventRecurrence to fill it. */
export const getEventRecurrence = query({
  args: { eventId: v.union(v.id("events"), v.id("sharedEvents")) },
  handler: async (ctx, { eventId }): Promise<string[] | null> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return null;
    }
    const event = await ctx.db.get(eventId);
    // Shared public-calendar events are read-only and carry no editable series
    // (no `userId`); the recurrence panel doesn't apply to them.
    if (!event || !("userId" in event)) {
      return null;
    }
    if (event.userId !== user._id || !event.recurringEventId) {
      return null;
    }
    const recurringEventId = event.recurringEventId;

    const series = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q
          .eq("userId", user._id)
          .eq("calendarId", event.calendarId)
          .eq("googleEventId", recurringEventId),
      )
      .unique();
    return series && series.sourceUpdatedMs >= event.googleUpdatedMs
      ? series.recurrence
      : null;
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
    /** Ask Google to mint a Google Meet link; the URL comes back as `hangoutLink`. */
    addConference: v.optional(v.boolean()),
    /** Idempotency key, stable across retries of the same user intent. A retry
     * with the same id reuses the already-created Google event (via a
     * derived stable event id + duplicate-409-as-success) instead of creating a
     * second event and re-emailing guests. See googleEventIdForOperation. */
    operationId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<MappedEvent> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    const accessToken = await getGoogleAccessToken(ctx, user._id);
    return await createEventOp(ctx, user._id, accessToken, args);
  },
});

/** An event plus the calendar it lives on — everything `eventCapabilities`
 * needs, in one round trip. The join is on the Google id, since `events` stores
 * its calendar as that string rather than as a document reference. */
export const getEventContext = internalQuery({
  args: {
    eventId: v.union(v.id("events"), v.id("sharedEvents")),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    // Read-only shared (public-calendar) events have no owner and no capabilities
    // to compute; callers treat a null context as "not editable".
    if (!event || !("userId" in event) || event.userId !== args.userId) {
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

/** Fill or refresh the Convex series cache from Google's recurring master. */
export const refreshEventRecurrence = action({
  args: { eventId: v.union(v.id("events"), v.id("sharedEvents")) },
  handler: async (ctx, { eventId }): Promise<null> => {
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
    if (!context.event.recurringEventId) {
      return null;
    }

    const accessToken = await getGoogleAccessToken(ctx, user._id);

    const master = await getCalendarEvent(
      accessToken,
      context.event.calendarId,
      context.event.recurringEventId,
    );
    await ctx.runMutation(internal.calendar.upsertRecurringSeries, {
      userId: user._id,
      calendarId: context.event.calendarId,
      googleEventId: context.event.recurringEventId,
      recurrence: master.recurrence ?? [],
      sourceUpdatedMs: context.event.googleUpdatedMs,
    });
    return null;
  },
});

/** The opening move of every action that writes to Google: resolve the
 * signed-in user and get them a token. Whether they may touch the *event* is a
 * separate question, answered inside each op by `resolveEventForWrite`. */
async function authedWrite(
  ctx: ActionCtx,
): Promise<{ userId: string; accessToken: string }> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }
  return {
    userId: user._id,
    accessToken: await getGoogleAccessToken(ctx, user._id),
  };
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
    const { userId, accessToken } = await authedWrite(ctx);
    return await updateEventTimeOp(ctx, userId, accessToken, args);
  },
});

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
    /** Idempotency key, stable across retries of the same user intent. Used by
     * the `thisAndFollowing` split, whose tail insert creates a new series: a
     * retry with the same id reuses that series (derived stable id + 409-as-
     * success) instead of duplicating it and re-emailing guests. */
    operationId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<MappedEvent> => {
    const { userId, accessToken } = await authedWrite(ctx);
    return await updateEventOp(ctx, userId, accessToken, args);
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
    const { userId, accessToken } = await authedWrite(ctx);
    return await respondToEventOp(ctx, userId, accessToken, args);
  },
});

/** Delete one occurrence, this and following occurrences, or a whole series. */
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
  handler: async (ctx, args): Promise<null> => {
    const { userId, accessToken } = await authedWrite(ctx);
    return await deleteEventOp(ctx, userId, accessToken, args);
  },
});

/** Drop the local row as soon as Google accepts the delete, so the card leaves
 * the grid now rather than whenever the next sync happens to run. */
export const deleteEventRow = internalMutation({
  args: {
    eventId: v.id("events"),
    userId: v.string(),
    calendarId: v.optional(v.string()),
    recurringEventId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
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
      await ctx.db.replace(existing._id, { userId: args.userId, ...args.event });
    } else {
      await ctx.db.insert("events", { userId: args.userId, ...args.event });
    }
    return null;
  },
});

/** Cache one recurring master's rule for all of its expanded instances. */
export const upsertRecurringSeries = internalMutation({
  args: {
    userId: v.string(),
    calendarId: v.string(),
    googleEventId: v.string(),
    recurrence: v.array(v.string()),
    sourceUpdatedMs: v.number(),
    /** Existing single-event mirror replaced when that Google id becomes a
     * hidden recurring master. Kept in this mutation so cache + removal commit
     * together before expanded instances are synced. */
    replacedEventId: v.optional(v.id("events")),
  },
  handler: async (ctx, args): Promise<null> => {
    const existing = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q
          .eq("userId", args.userId)
          .eq("calendarId", args.calendarId)
          .eq("googleEventId", args.googleEventId),
      )
      .unique();
    const value = {
      recurrence: args.recurrence,
      sourceUpdatedMs: args.sourceUpdatedMs,
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
  },
});
