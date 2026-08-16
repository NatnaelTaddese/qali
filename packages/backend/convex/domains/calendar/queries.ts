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
  selectedCalendarIds,
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
  args: { userId: string; connectionId: Id<"calendarConnections"> },
): Promise<Doc<"calendarConnections"> | null> {
  const connection = await ctx.db.get(args.connectionId);
  if (
    !connection ||
    connection.userId !== args.userId ||
    connection.status !== "active"
  ) {
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
  const selected = await selectedCalendarIds(ctx, user._id);
  // Overlap is `endMs > startMs && startMs < endMs`. Range each calendar's
  // `by_..._end` index on endMs so a multi-day event that began before the
  // window is caught, bound the far side with MAX_EVENT_SPAN_MS, and cap the
  // combined read with one row budget.
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
  const selected = await selectedCalendarIds(ctx, user._id);
  if (!selected.has(row.calendarId)) {
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
  const calendar = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (q) =>
      q.eq("userId", args.userId).eq("googleCalendarId", event.calendarId),
    )
    .unique();
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
