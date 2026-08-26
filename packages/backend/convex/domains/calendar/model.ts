/**
 * Calendar domain model: the shared read helpers and the unified event view.
 * No Convex function wrappers here — those stay in the domain's queries.ts.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  MAX_EVENT_SPAN_MS,
  type RowBudget,
  spendRowBudget,
} from "../../shared/eventReads";

// The window is caller-supplied, so bound it: the widest legitimate view (a
// 7-month month-grid, see QUERY_SIDE_MONTHS on the client) is ~214 days, so 400
// days leaves headroom while stopping a forged range from scanning years of rows
// in one unpaginated read.
export const MAX_EVENT_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

// Public calendars are small (a year of holidays is well under this), so a flat
// cap per calendar is enough to stay bounded without a density error.
export const ASSISTANT_SHARED_EVENT_LIMIT = 400;

export async function selectedCalendars(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"calendars">[]> {
  return (await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect()).filter((calendar) => calendar.selected);
}

/**
 * A calendar event as the client sees it: either a synced `events` row or a
 * public `sharedEvents` row (holidays, birthdays) presented in the same shape.
 *
 * The id is honestly the union of both tables rather than a cast to `Id<"events">`.
 * A shared row is read-only, so its `Id<"sharedEvents">` must never be handed to
 * an events-only mutation — the union makes the compiler enforce it. The read
 * queries that do accept a shared id already validate the union.
 */
export type EventView = Omit<Doc<"events">, "_id"> & {
  _id: Id<"events"> | Id<"sharedEvents">;
};

/** Present a shared (public-calendar) row in the unified {@link EventView} shape.
 * `userId` is stamped to the reader, and the local identity (`connectionId`,
 * `localCalendarId`) comes from the reader's own `calendars` row for the shared
 * calendar — a shared row carries none of its own, and clients join calendar
 * metadata on `localCalendarId` uniformly. */
export function sharedAsEvent(
  row: Doc<"sharedEvents">,
  userId: string,
  calendar: Doc<"calendars">,
): EventView {
  return {
    ...row,
    userId,
    connectionId: calendar.connectionId,
    localCalendarId: calendar._id,
  };
}

/** Selected public calendars' events overlapping [fromMs, toMs). These live once
 * in `sharedEvents` (not per-user), so we read them by provider identity and
 * merge into the caller's own events. Cancelled shared events are never stored.
 *
 * Ranged on `endMs` (not `startMs`) so a multi-day holiday that began before the
 * window is still returned; the far side is bounded by `MAX_EVENT_SPAN_MS` and the
 * combined row `budget` guards against a pathological range. */
export async function readSharedEventsInRange(
  ctx: QueryCtx,
  userId: string,
  publicCalendars: Doc<"calendars">[],
  fromMs: number,
  toMs: number,
  budget: RowBudget,
): Promise<EventView[]> {
  const spanEnd = toMs + MAX_EVENT_SPAN_MS;
  const out: EventView[] = [];
  for (const calendar of publicCalendars) {
    const connectionId = calendar.connectionId;
    const providerCalendarId = calendar.providerCalendarId;
    if (connectionId === undefined || providerCalendarId === undefined) {
      continue;
    }
    const connection = await ctx.db.get(connectionId);
    if (!connection) continue;
    const page = await ctx.db
      .query("sharedEvents")
      .withIndex("by_provider_and_providerCalendarId_and_endMs", (q) =>
        q
          .eq("provider", connection.provider)
          .eq("providerCalendarId", providerCalendarId)
          .gt("endMs", fromMs)
          .lte("endMs", spanEnd),
      )
      .take(budget.remaining + 1);
    spendRowBudget(budget, page.length);
    for (const r of page) {
      if (r.startMs < toMs) {
        out.push(sharedAsEvent(r, userId, calendar));
      }
    }
  }
  return out;
}
