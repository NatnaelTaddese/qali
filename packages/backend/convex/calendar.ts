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
  mapGoogleEvent,
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

/** The cached rule for an expanded recurring instance. `null` is a cache miss
 * (or stale cache); the client can ask refreshEventRecurrence to fill it. */
export const getEventRecurrence = query({
  args: { eventId: v.id("events") },
  handler: async (ctx, { eventId }): Promise<string[] | null> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return null;
    }
    const event = await ctx.db.get(eventId);
    if (!event || event.userId !== user._id || !event.recurringEventId) {
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
      args.addConference,
    );

    if (args.recurrence && args.recurrence.length > 0) {
      await ctx.runMutation(internal.calendar.upsertRecurringSeries, {
        userId: user._id,
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
      await resyncCalendar(ctx, user._id, accessToken, targetCalendarId);
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

/** Fill or refresh the Convex series cache from Google's recurring master. */
export const refreshEventRecurrence = action({
  args: { eventId: v.id("events") },
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

    const { accessToken } = await createAuth(ctx).api.getAccessToken({
      body: { providerId: "google", userId: user._id },
    });
    if (!accessToken) {
      throw new Error("No Google access token available for user");
    }

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

/**
 * Pull a calendar's events in again after a change Google stores on a hidden
 * recurring master (create/split/series-edit). We sync with singleEvents=true,
 * so the master is never a row of ours — only its *expanded* instances are, and
 * the way to reflect a master change is to re-expand. Reused by `createEvent`
 * and the series-wide branches of `updateEvent`; a no-op if the calendar hasn't
 * synced yet.
 */
async function resyncCalendar(
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
  },
  handler: async (ctx, args): Promise<MappedEvent> => {
    const { userId, row, accessToken } = await authorizeEventAction(
      ctx,
      args.eventId,
      ["canEdit"],
    );

    // A non-recurring event has no series, so any scope collapses to the one
    // event; only a recurring instance can reach the master.
    const scope = row.recurringEventId ? (args.scope ?? "thisEvent") : "thisEvent";

    // Falling back to the stored value keeps a times-only patch rendering the
    // same kind of event it already was.
    const allDay = args.allDay ?? row.allDay;
    const hasTimeChange =
      args.startMs !== undefined && args.endMs !== undefined;

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
      attendees: args.attendees,
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
      const event = await patchCalendarEvent(
        accessToken,
        row.calendarId,
        row.googleEventId,
        { ...times, ...fields },
        sendUpdates,
        conference,
      );
      await ctx.runMutation(internal.calendar.upsertEvent, { userId, event });
      return event;
    }

    // Series-wide scopes need the master, both for its recurrence rule and (for
    // a time change) for the absolute times we shift by the instance's delta.
    const masterId = row.recurringEventId;
    if (!masterId) {
      throw new Error("Event is not part of a recurring series");
    }
    const rawMaster = await getCalendarEvent(
      accessToken,
      row.calendarId,
      masterId,
    );
    const master = mapGoogleEvent(rawMaster, row.calendarId);

    // Google requires a time zone on a recurring event's start/end. The client
    // only sends one when the times change, so fall back to the master series'
    // own stored zone — the correct anchor for any occurrence of the series.
    const effectiveTimeZone = args.timeZone ?? rawMaster.start?.timeZone;

    // Shift the master's own start/end by the delta the user applied to this
    // instance, so every occurrence moves by the same amount.
    const shiftedTimes =
      hasTimeChange && args.startMs !== undefined && args.endMs !== undefined
        ? {
            start: toGoogleTime(
              master.startMs + (args.startMs - row.startMs),
              allDay,
              effectiveTimeZone,
            ),
            end: toGoogleTime(
              master.endMs + (args.endMs - row.endMs),
              allDay,
              effectiveTimeZone,
            ),
          }
        : {};

    // "This and following" from the very first occurrence has nothing before it
    // to keep, so it is just "all events" — patch the master rather than split
    // the series into an empty original.
    const isSeriesHead = row.startMs === master.startMs;

    if (scope === "allEvents" || isSeriesHead) {
      const updatedMaster = await patchCalendarEvent(
        accessToken,
        row.calendarId,
        masterId,
        { ...shiftedTimes, ...fields },
        sendUpdates,
        conference,
      );
      await resyncCalendar(ctx, userId, accessToken, row.calendarId);
      return updatedMaster;
    }

    // scope === "thisAndFollowing", on a mid-series occurrence: split.
    //
    // 1. End the original series just before this occurrence. NOTE: a COUNT=N
    //    rule is reset to an UNTIL here and copied whole onto the new series
    //    below, so the tail keeps its own COUNT rather than N-minus-elapsed —
    //    an over-count only counting expanded occurrences could fix. UNTIL and
    //    open-ended rules (the common cases) split exactly.
    const truncated = truncateRecurrence(
      rawMaster.recurrence ?? [],
      row.startMs - 1000,
      row.allDay,
    );
    const truncatedMaster = await patchCalendarEvent(
      accessToken,
      row.calendarId,
      masterId,
      { recurrence: truncated },
    );
    await ctx.runMutation(internal.calendar.upsertRecurringSeries, {
      userId,
      calendarId: row.calendarId,
      googleEventId: masterId,
      recurrence: truncated,
      sourceUpdatedMs: truncatedMaster.googleUpdatedMs,
    });

    // 2. Create a fresh series from this occurrence. Each field is the edit if
    //    the user touched it, else the instance's current value carried across;
    //    a field the user *cleared* (null) is dropped rather than carried.
    const carried = <T>(edited: T | null | undefined, current: T | undefined) =>
      edited === undefined ? current : (edited ?? undefined);
    const newStartMs = hasTimeChange && args.startMs !== undefined ? args.startMs : row.startMs;
    const newEndMs = hasTimeChange && args.endMs !== undefined ? args.endMs : row.endMs;
    const attendees =
      args.attendees ??
      row.attendees?.map((a) => ({
        email: a.email,
        displayName: a.displayName,
        optional: a.optional,
      }));
    // Keep an existing Meet on the tail unless the edit removed it; mint one if
    // the edit added it. The new series gets its own link, not the original's.
    const addConference =
      args.conference === null
        ? false
        : args.conference === "meet"
          ? true
          : Boolean(row.hangoutLink);

    const newSeries = await insertCalendarEvent(
      accessToken,
      row.calendarId,
      {
        summary: args.summary ?? row.summary ?? "(No title)",
        description: carried(args.description, row.description),
        location: carried(args.location, row.location),
        start: toGoogleTime(newStartMs, allDay, effectiveTimeZone),
        end: toGoogleTime(newEndMs, allDay, effectiveTimeZone),
        colorId: carried(args.colorId, row.colorId),
        visibility: carried(args.visibility, row.visibility),
        transparency: args.transparency ?? row.transparency,
        attendees,
        recurrence: rawMaster.recurrence ?? [],
      },
      attendees && attendees.length > 0 ? "all" : undefined,
      addConference,
    );
    await ctx.runMutation(internal.calendar.upsertRecurringSeries, {
      userId,
      calendarId: row.calendarId,
      googleEventId: newSeries.googleEventId,
      recurrence: rawMaster.recurrence ?? [],
      sourceUpdatedMs: newSeries.googleUpdatedMs,
    });

    // 3. Re-expand both the truncated original and the new series into rows.
    await resyncCalendar(ctx, userId, accessToken, row.calendarId);
    return newSeries;
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
    return null;
  },
});
