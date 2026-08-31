/** Read side of the calendar domain. Registration is canonical here, under
 * `api.domains.calendar.queries.*` / `internal.domains.calendar.queries.*`. */

import { v } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import { internalQuery, query, type QueryCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  MAX_EVENT_SPAN_MS,
  newRowBudget,
  spendRowBudget,
} from "../../shared/eventReads";
import {
  ASSISTANT_SHARED_EVENT_LIMIT,
  type EventView,
  MAX_EVENT_RANGE_MS,
  readSharedEventsInRange,
  selectedCalendars,
  sharedAsEvent,
} from "./model";
import { eventIdArg } from "./validators";

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
  const sharedCalendars = calendars.filter((c) => c.selected && c.isShared);

  const out: EventView[] = [];
  for (const calendar of sharedCalendars) {
    const connectionId = calendar.connectionId;
    const providerCalendarId = calendar.providerCalendarId;
    if (connectionId === undefined || providerCalendarId === undefined) {
      continue;
    }
    const connection = await ctx.db.get(connectionId);
    if (!connection) continue;
    const rows = await ctx.db
      .query("sharedEvents")
      .withIndex("by_provider_and_providerCalendarId_and_endMs", (q) =>
        q
          .eq("provider", connection.provider)
          .eq("providerCalendarId", providerCalendarId)
          .gt("endMs", args.startMs),
      )
      .take(ASSISTANT_SHARED_EVENT_LIMIT);
    for (const r of rows) {
      if (r.startMs < args.endMs) {
        out.push(sharedAsEvent(r, args.userId, calendar));
      }
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

export const listSharedEventsForAssistant = internalQuery({
  args: { userId: v.string(), startMs: v.number(), endMs: v.number() },
  handler: (ctx, args) => listSharedEventsForAssistantHandler(ctx, args),
});

/** The user's connected calendars, for the visibility list in the header.
 * A deliberate DTO: sync cursors, generations, and lease state stay private. */
export async function listCalendarsHandler(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return [];
  }
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  return calendars.map((calendar) => ({
    _id: calendar._id,
    connectionId: calendar.connectionId,
    providerCalendarId: calendar.providerCalendarId,
    summary: calendar.summary,
    summaryOverride: calendar.summaryOverride,
    backgroundColor: calendar.backgroundColor,
    primary: calendar.primary,
    accessRole: calendar.accessRole,
    timeZone: calendar.timeZone,
    selected: calendar.selected,
    providerSelected: calendar.providerSelected,
    isShared: calendar.isShared,
  }));
}

export const listCalendars = query({
  args: {},
  handler: (ctx) => listCalendarsHandler(ctx),
});

/** The user's provider connections with their sync bookkeeping, for the
 * settings panel. A deliberate DTO like listCalendars: credentialRef, cursors,
 * leases, and generations stay private. */
export async function listConnectionsHandler(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return [];
  }
  const connections = await ctx.db
    .query("calendarConnections")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  return Promise.all(
    connections.map(async (connection) => {
      const syncState = await ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) =>
          q.eq("connectionId", connection._id),
        )
        .unique();
      return {
        _id: connection._id,
        provider: connection.provider,
        providerAccountId: connection.providerAccountId,
        status: connection.status,
        contactsEnabled:
          (connection.capabilities?.contacts ?? false) &&
          connection.contactsSyncEnabled !== false,
        lastError: connection.lastError,
        createdAt: connection.createdAt,
        syncStatus: syncState?.status,
        syncLastError: syncState?.lastError,
        syncIntervalMs: syncState?.syncIntervalMs,
        nextSyncDueAt: syncState?.nextSyncDueAt,
        // Stamped by recordSyncOutcome; scanning per-calendar lastSyncAt here
        // would re-run this reactive query on every calendar's sync write.
        lastSyncAt: syncState?.lastSyncAt,
      };
    }),
  );
}

export const listConnections = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("calendarConnections"),
      provider: v.union(v.literal("google"), v.literal("microsoft")),
      providerAccountId: v.optional(v.string()),
      status: v.union(
        v.literal("active"),
        v.literal("paused"),
        v.literal("error"),
      ),
      contactsEnabled: v.boolean(),
      lastError: v.optional(v.string()),
      createdAt: v.number(),
      syncStatus: v.optional(
        v.union(v.literal("idle"), v.literal("syncing"), v.literal("error")),
      ),
      syncLastError: v.optional(v.string()),
      syncIntervalMs: v.optional(v.number()),
      nextSyncDueAt: v.optional(v.number()),
      lastSyncAt: v.optional(v.number()),
    }),
  ),
  handler: (ctx) => listConnectionsHandler(ctx),
});

/** Registry lookup that deliberately hides foreign and inactive connections. */
export async function getCalendarConnectionForAdapterHandler(
  ctx: QueryCtx,
  args: { connectionId: Id<"calendarConnections">; userId: string },
): Promise<Doc<"calendarConnections"> | null> {
  const connection = await ctx.db.get(args.connectionId);
  if (
    !connection ||
    connection.status !== "active" ||
    connection.userId !== args.userId
  ) {
    return null;
  }
  return connection;
}

export const getCalendarConnectionForAdapter = internalQuery({
  args: {
    connectionId: v.id("calendarConnections"),
    userId: v.string(),
  },
  handler: (ctx, args) => getCalendarConnectionForAdapterHandler(ctx, args),
});

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
  // `by_..._endMs` index on endMs so a multi-day event that began before the
  // window is caught, bound the far side with MAX_EVENT_SPAN_MS, and cap the
  // combined read with one row budget.
  const budget = newRowBudget();
  const personalCalendars = selected.filter((calendar) => !calendar.isShared);
  const publicCalendars = selected.filter((calendar) => calendar.isShared);
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

export const listEventsInRange = query({
  args: { startMs: v.number(), endMs: v.number() },
  handler: (ctx, args) => listEventsInRangeHandler(ctx, args),
});

/** Each calendar's events by its own connection-scoped end index. Rows written
 * before the provider cutover lack the neutral keys and are simply not seen. */
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
    if (calendar.userId !== userId) continue;
    const page = await ctx.db
      .query("events")
      .withIndex("by_connection_and_localCalendarId_and_endMs", (q) =>
        q
          .eq("connectionId", calendar.connectionId)
          .eq("localCalendarId", calendar._id)
          .gt("endMs", startMs)
          .lte("endMs", spanEnd),
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
  for (const calendar of selected) {
    if (!calendar.isShared) {
      continue;
    }
    const connectionId = calendar.connectionId;
    const providerCalendarId = calendar.providerCalendarId;
    if (connectionId === undefined || providerCalendarId === undefined) {
      continue;
    }
    const connection = await ctx.db.get(connectionId);
    if (
      connection &&
      connection.provider === row.provider &&
      providerCalendarId === row.providerCalendarId
    ) {
      return sharedAsEvent(row, user._id, calendar);
    }
  }
  return null;
}

export const getEventById = query({
  args: { eventId: eventIdArg },
  handler: (ctx, args) => getEventByIdHandler(ctx, args),
});

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
  if (event.userId !== user._id || !event.providerSeriesId) {
    return null;
  }
  const connectionId = event.connectionId;
  const localCalendarId = event.localCalendarId;
  const providerSeriesId = event.providerSeriesId;
  const providerUpdatedMs = event.providerUpdatedMs;
  if (
    connectionId === undefined ||
    localCalendarId === undefined ||
    providerUpdatedMs === undefined
  ) {
    return null;
  }

  const series = await ctx.db
    .query("recurringSeries")
    .withIndex("by_connection_and_localCalendarId_and_providerEventId", (q) =>
      q
        .eq("connectionId", connectionId)
        .eq("localCalendarId", localCalendarId)
        .eq("providerEventId", providerSeriesId),
    )
    .unique();
  return series &&
    series.providerUpdatedMs !== undefined &&
    series.providerUpdatedMs >= providerUpdatedMs
    ? series.recurrence
    : null;
}

export const getEventRecurrence = query({
  args: { eventId: eventIdArg },
  handler: (ctx, args) => getEventRecurrenceHandler(ctx, args),
});

/** An event plus the calendar it lives on — everything `eventCapabilities` needs. */
export async function getEventContextHandler(
  ctx: QueryCtx,
  args: { eventId: Id<"events"> | Id<"sharedEvents">; userId: string },
): Promise<{ event: Doc<"events">; calendar: Doc<"calendars"> | null } | null> {
  const event = await ctx.db.get(args.eventId);
  if (!event || !("userId" in event) || event.userId !== args.userId) {
    return null;
  }
  const calendar = event.localCalendarId
    ? await ctx.db.get(event.localCalendarId)
    : null;
  return { event, calendar };
}

export const getEventContext = internalQuery({
  args: { eventId: eventIdArg, userId: v.string() },
  handler: (ctx, args) => getEventContextHandler(ctx, args),
});
