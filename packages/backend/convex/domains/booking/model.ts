/**
 * Booking domain model: constants, the page/slot shared reads, and the
 * server-side slot derivation both the public listing and the write path run
 * through so they can never disagree. No Convex function wrappers here.
 */

import { v } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  addDaysToDateKey,
  allDayBusyInterval,
  generateSlotGrid,
  type Interval,
  MS_PER_DAY,
  type SlotOption,
  utcToZoned,
} from "@qali/domain/availability";
import {
  MAX_EVENT_SPAN_MS,
  newRowBudget,
  spendRowBudget,
} from "../../lib/eventReads";

/** Settings a new page starts on: business hours, half-hour slots, two hours'
 * notice, two months ahead. */
export const DEFAULT_PAGE = {
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeMinutes: 120,
  horizonDays: 60,
  rules: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    startMin: 9 * 60,
    endMin: 17 * 60,
  })),
};

/** How much of a window `listOpenSlots` will answer at once. A month of slots
 * is more than any picker shows, and the cap keeps the public query from being
 * turned into a long scan of the host's events. */
export const MAX_SLOT_RANGE_MS = 35 * MS_PER_DAY;

export const RATE_WINDOW_MS = 60 * 60 * 1000;
export const MAX_REQUESTS_PER_EMAIL = 3;
export const MAX_REQUESTS_PER_PAGE = 20;
export const MAX_PENDING_BOOKINGS = 500;
export const EXPIRATION_BATCH_SIZE = 100;
export const ACCEPT_LEASE_MS = 2 * 60 * 1000;

export const slotSettingsValidator = {
  slotMinutes: v.number(),
  bufferMinutes: v.number(),
  minNoticeMinutes: v.number(),
  horizonDays: v.number(),
};

// --- Shared reads ---------------------------------------------------------

export async function pageByUser(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"bookingPages"> | null> {
  return await ctx.db
    .query("bookingPages")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

export async function pageBySlug(
  ctx: QueryCtx,
  slug: string,
): Promise<Doc<"bookingPages"> | null> {
  return await ctx.db
    .query("bookingPages")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

/**
 * Everything the host is already committed to between `fromMs` and `toMs`, as
 * bare intervals: busy events on their visible calendars, plus bookings that are
 * pending or already accepted.
 *
 * `excludeBookingId` lets the accept path ask "is this slot free apart from the
 * request I am about to accept?".
 */
export async function collectBusy(
  ctx: QueryCtx,
  page: Doc<"bookingPages">,
  fromMs: number,
  toMs: number,
  excludeBookingId?: Id<"bookings">,
  excludeGoogleEventId?: string,
): Promise<Interval[]> {
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", page.userId))
    .collect();
  const visible = calendars
    .filter((c) => c.selected)
    .map((c) => c.googleCalendarId);

  // Overlap is `endMs > fromMs && startMs < toMs`. Range each visible calendar's
  // end index on endMs so a multi-day event that began before the window still
  // withholds the time (the old startMs lookback missed those); bound the far
  // side by MAX_EVENT_SPAN_MS and the combined read by one row budget.
  const budget = newRowBudget();
  const spanEnd = toMs + MAX_EVENT_SPAN_MS;
  const busy: Interval[] = [];
  for (const calendarId of visible) {
    const events = await ctx.db
      .query("events")
      .withIndex("by_user_and_calendar_and_end", (q) =>
        q
          .eq("userId", page.userId)
          .eq("calendarId", calendarId)
          .gt("endMs", fromMs)
          .lte("endMs", spanEnd),
      )
      .take(budget.remaining + 1);
    spendRowBudget(budget, events.length);
    for (const event of events) {
      if (event.startMs >= toMs) continue;
      if (event.googleEventId === excludeGoogleEventId) continue;
      if (event.status === "cancelled") continue;
      // The host marked this one "free" in their own calendar, so it is not a
      // reason to withhold the time.
      if (event.transparency === "transparent") continue;
      busy.push(
        event.allDay
          ? allDayBusyInterval(event.startMs, event.endMs, page.timeZone)
          : { startMs: event.startMs, endMs: event.endMs },
      );
    }
  }

  const bookings = await ctx.db
    .query("bookings")
    .withIndex("by_host_and_end", (q) =>
      q.eq("hostUserId", page.userId).gt("endMs", fromMs).lte("endMs", spanEnd),
    )
    .take(budget.remaining + 1);
  spendRowBudget(budget, bookings.length);
  for (const booking of bookings) {
    if (booking.startMs >= toMs) continue;
    if (booking.status === "rejected" || booking.status === "expired") continue;
    if (booking._id === excludeBookingId) continue;
    busy.push({ startMs: booking.startMs, endMs: booking.endMs });
  }

  return busy;
}

/**
 * The page's slot grid, derived entirely server-side: every slot the host's
 * schedule puts on offer, each flagged bookable or taken. Both the public
 * listing and the write path go through this, so they cannot disagree.
 */
export async function slotGrid(
  ctx: QueryCtx,
  page: Doc<"bookingPages">,
  fromMs: number,
  toMs: number,
): Promise<SlotOption[]> {
  // Only the overrides whose date falls in the rendered window matter, and the
  // window is capped at MAX_SLOT_RANGE_MS — so bound the scan to that date range
  // instead of collecting every override the host has ever set. dateKeys are ISO
  // "YYYY-MM-DD" strings, so lexical index order is chronological; the ±1 day pad
  // matches generateSlotGrid's own firstKey/lastKey so nothing rendered is missed.
  const firstKey = addDaysToDateKey(utcToZoned(fromMs, page.timeZone).dateKey, -1);
  const lastKey = addDaysToDateKey(utcToZoned(toMs, page.timeZone).dateKey, 1);
  const overrides = await ctx.db
    .query("availabilityOverrides")
    .withIndex("by_user_and_date", (q) =>
      q.eq("userId", page.userId).gte("dateKey", firstKey).lte("dateKey", lastKey),
    )
    .collect();

  return generateSlotGrid({
    timeZone: page.timeZone,
    rules: page.rules,
    overrides: overrides.map((o) => ({
      dateKey: o.dateKey,
      intervals: o.intervals,
    })),
    busy: await collectBusy(ctx, page, fromMs, toMs),
    slotMinutes: page.slotMinutes,
    bufferMinutes: page.bufferMinutes,
    minNoticeMinutes: page.minNoticeMinutes,
    horizonDays: page.horizonDays,
    fromMs,
    toMs,
    nowMs: Date.now(),
  });
}

/** A short, human date range for a booking notification, in the host's zone —
 * e.g. "Mon, Aug 4 · 2:00 – 2:30 PM". Display only. */
export function bookingNotificationBody(
  startMs: number,
  endMs: number,
  timeZone: string,
): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(startMs);
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day} · ${timeFmt.format(startMs)} – ${timeFmt.format(endMs)}`;
}
