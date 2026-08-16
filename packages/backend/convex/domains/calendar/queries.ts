/** Read handlers for the calendar domain. Plain functions; the root `calendar.ts`
 * wraps each in a Convex `query` / `internalQuery`. */

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  MAX_EVENT_SPAN_MS,
  newRowBudget,
  spendRowBudget,
} from "../../shared/eventReads";
import {
  ASSISTANT_SHARED_EVENT_LIMIT,
  type EventView,
  isSharedPublicCalendar,
  MAX_EVENT_RANGE_MS,
  readSharedEventsInRange,
  selectedCalendars,
  sharedAsEvent,
} from "./model";

/** The assistant's view of shared public-calendar (holiday/birthday) events in a
 * range, for the selected calendars. Normalized to the events shape. */
export async function listSharedEventsForAssistantHandler(
  ctx: QueryCtx,
  args: { userId: string; startMs: number; endMs: number },
): Promise<EventView[]> {
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .collect();
  const sharedCalendars = calendars.filter(
    (c) => c.selected && (c.isShared ?? isSharedPublicCalendar(c.googleCalendarId)),
  );

  const out: EventView[] = [];
  for (const calendar of sharedCalendars) {
    const connection = calendar.connectionId
      ? await ctx.db.get(calendar.connectionId)
      : null;
    const rows = await ctx.db
      .query("sharedEvents")
      .withIndex("by_calendar_and_end", (q) =>
        q
          .eq("calendarId", calendar.googleCalendarId)
          .gt("endMs", args.startMs),
      )
      .take(ASSISTANT_SHARED_EVENT_LIMIT);
    for (const r of rows) {
      if (
        (r.provider ?? "google") === (connection?.provider ?? "google") &&
        (r.providerCalendarId ?? r.calendarId) ===
          (calendar.providerCalendarId ?? calendar.googleCalendarId) &&
        r.startMs < args.endMs
      ) {
        out.push(sharedAsEvent(r, args.userId));
      }
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** The user's connected calendars, for the visibility list in the header. */
export async function listCalendarsHandler(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return [];
  }
  return await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
}

/** Registry lookup that deliberately hides foreign and inactive connections. */
export async function getCalendarConnectionForAdapterHandler(
  ctx: QueryCtx,
  args: { connectionId: Id<"calendarConnections"> },
): Promise<Doc<"calendarConnections"> | null> {
  const connection = await ctx.db.get(args.connectionId);
  if (!connection || connection.status !== "active") {
    return null;
  }
  return connection;
}

/** Upcoming events for the current user, read from the synced `events` table. */
export async function listEventsHandler(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return [];
  }
  const selected = await selectedCalendars(ctx, user._id);
  const selectedLocalIds = new Set(selected.map((calendar) => calendar._id));
  const selectedLegacyIds = new Set(selected.map((calendar) => calendar.googleCalendarId));
  const now = Date.now();
  const personal = (
    await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) =>
        q.eq("userId", user._id).gte("startMs", now),
      )
      .order("asc")
      .take(50)
  ).filter((event) =>
    event.localCalendarId
      ? selectedLocalIds.has(event.localCalendarId)
      : selectedLegacyIds.has(event.calendarId),
  );
  const publicCalendars = selected.filter(
    (calendar) =>
      calendar.isShared ?? isSharedPublicCalendar(calendar.googleCalendarId),
  );
  const shared: EventView[] = [];
  for (const calendar of publicCalendars) {
    const connection = calendar.connectionId
      ? await ctx.db.get(calendar.connectionId)
      : null;
    const rows = await ctx.db
      .query("sharedEvents")
      .withIndex("by_calendar_and_start", (q) =>
        q
          .eq("calendarId", calendar.googleCalendarId)
          .gte("startMs", now),
      )
      .order("asc")
      .take(50);
    shared.push(
      ...rows
        .filter(
          (row) =>
            (row.provider ?? "google") ===
              (connection?.provider ?? "google") &&
            (row.providerCalendarId ?? row.calendarId) ===
              (calendar.providerCalendarId ?? calendar.googleCalendarId),
        )
        .map((row) => sharedAsEvent(row, user._id)),
    );
  }
  return [...personal, ...shared]
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, 50);
}

/** Events overlapping [startMs, endMs) for the current user, e.g. a week window. */
export async function listEventsInRangeHandler(
  ctx: QueryCtx,
  { startMs, endMs }: { startMs: number; endMs: number },
) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return [];
  }
  if (endMs <= startMs || endMs - startMs > MAX_EVENT_RANGE_MS) {
    throw new Error("Requested calendar range is too large");
  }
  const selected = await selectedCalendars(ctx, user._id);
  // Overlap is `endMs > startMs && startMs < endMs`. Range each calendar's
  // `by_..._end` index on endMs so a multi-day event that began before the
  // window is caught, bound the far side with MAX_EVENT_SPAN_MS, and cap the
  // combined read with one row budget.
  const budget = newRowBudget();
  const personalCalendars = selected.filter(
    (calendar) =>
      !(calendar.isShared ?? isSharedPublicCalendar(calendar.googleCalendarId)),
  );
  const publicCalendars = selected.filter(
    (calendar) =>
      calendar.isShared ?? isSharedPublicCalendar(calendar.googleCalendarId),
  );
  const personal = await readPersonalEventsInRange(
    ctx,
    user._id,
    personalCalendars,
    startMs,
    endMs,
    budget,
  );
  const shared = await readSharedEventsInRange(
    ctx,
    user._id,
    publicCalendars,
    startMs,
    endMs,
    budget,
  );
  return [...personal, ...shared].sort((a, b) => a.startMs - b.startMs);
}

/** Migration-safe active read. The staged neutral end index replaces this only
 * after activation; until then this complete legacy end range includes both
 * backfilled and not-yet-backfilled rows without scanning provider-event order. */
export async function readPersonalEventsInRange(
  ctx: QueryCtx,
  userId: string,
  calendars: Doc<"calendars">[],
  startMs: number,
  endMs: number,
  budget = newRowBudget(),
): Promise<Doc<"events">[]> {
  const spanEnd = endMs + MAX_EVENT_SPAN_MS;
  const events: Doc<"events">[] = [];
  for (const calendar of calendars) {
    const page = await ctx.db
      .query("events")
      .withIndex("by_user_and_calendar_and_end", (q) =>
        q
          .eq("userId", userId)
          .eq("calendarId", calendar.googleCalendarId)
          .gt("endMs", startMs)
          .lte("endMs", spanEnd),
      )
      .filter((q) =>
        q.or(
          q.eq(q.field("localCalendarId"), undefined),
          q.eq(q.field("localCalendarId"), calendar._id),
        ),
      )
      .take(budget.remaining + 1);
    spendRowBudget(budget, page.length);
    for (const event of page) {
      if (event.startMs < endMs && event.status !== "cancelled") {
        events.push(event);
      }
    }
  }
  return events;
}

/** One event, live. */
export async function getEventByIdHandler(
  ctx: QueryCtx,
  { eventId }: { eventId: Id<"events"> | Id<"sharedEvents"> },
) {
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
  // returned to a caller who actually has that calendar selected.
  const selected = await selectedCalendars(ctx, user._id);
  let allowed = false;
  for (const calendar of selected) {
    if (!(calendar.isShared ?? isSharedPublicCalendar(calendar.googleCalendarId))) {
      continue;
    }
    const connection = calendar.connectionId
      ? await ctx.db.get(calendar.connectionId)
      : null;
    if (
      (connection?.provider ?? "google") === (row.provider ?? "google") &&
      (calendar.providerCalendarId ?? calendar.googleCalendarId) ===
        (row.providerCalendarId ?? row.calendarId)
    ) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    return null;
  }
  return sharedAsEvent(row, user._id);
}

/** The cached rule for an expanded recurring instance. `null` is a cache miss. */
export async function getEventRecurrenceHandler(
  ctx: QueryCtx,
  { eventId }: { eventId: Id<"events"> | Id<"sharedEvents"> },
): Promise<string[] | null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return null;
  }
  const event = await ctx.db.get(eventId);
  // Shared public-calendar events are read-only and carry no editable series.
  if (!event || !("userId" in event)) {
    return null;
  }
  if (event.userId !== user._id || !event.recurringEventId) {
    return null;
  }
  const recurringEventId = event.recurringEventId;

  const neutralSeries =
    event.connectionId && event.localCalendarId
      ? await ctx.db
          .query("recurringSeries")
          .withIndex(
            "by_connection_and_localCalendarId_and_providerEventId",
            (q) =>
              q
                .eq("connectionId", event.connectionId)
                .eq("localCalendarId", event.localCalendarId)
                .eq("providerEventId", event.providerSeriesId ?? recurringEventId),
          )
          .unique()
      : null;
  const series =
    neutralSeries ??
    (await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q
          .eq("userId", user._id)
          .eq("calendarId", event.calendarId)
          .eq("googleEventId", recurringEventId),
      )
      .unique());
  return series && series.sourceUpdatedMs >= event.googleUpdatedMs
    ? series.recurrence
    : null;
}

/** An event plus the calendar it lives on — everything `eventCapabilities` needs. */
export async function getEventContextHandler(
  ctx: QueryCtx,
  args: { eventId: Id<"events"> | Id<"sharedEvents">; userId: string },
): Promise<{ event: Doc<"events">; calendar: Doc<"calendars"> | null } | null> {
  const event = await ctx.db.get(args.eventId);
  if (!event || !("userId" in event) || event.userId !== args.userId) {
    return null;
  }
  const neutralCalendar = event.localCalendarId
    ? await ctx.db.get(event.localCalendarId)
    : null;
  const calendar =
    neutralCalendar ??
    (await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q.eq("userId", args.userId).eq("googleCalendarId", event.calendarId),
      )
      .first());
  return { event, calendar };
}

/** Resolve the user's primary calendar id (the email), if it has synced. */
export async function getPrimaryCalendarIdHandler(
  ctx: QueryCtx,
  args: { userId: string },
): Promise<string | null> {
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .collect();
  return calendars.find((c) => c.primary)?.googleCalendarId ?? null;
}
