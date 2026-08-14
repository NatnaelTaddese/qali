/**
 * Public booking pages: a host publishes a weekly schedule at `/<slug>`, anyone
 * opens that link and requests a time, and the host accepts or rejects it.
 *
 * This is the app's only anonymous surface, so two rules run through the whole
 * file. First, nothing derived from the host's calendar leaves the server except
 * slot start times and whether each one is taken — a visitor learns when the host
 * is free, never what they are doing or with whom. Second, `requestBooking`
 * re-derives the slot itself: the list the client holds is advisory, and a forged
 * or stale `startMs` has to fail against the server's own answer.
 */

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authComponent } from "./auth";
import {
  addDaysToDateKey,
  allDayBusyInterval,
  generateSlotGrid,
  isValidDayInterval,
  mergeDayIntervals,
  type Interval,
  MS_PER_DAY,
  type SlotOption,
  utcToZoned,
} from "@qali/domain/availability";
import {
  getCalendarEvent,
  GoogleApiError,
  GoogleNetworkError,
  insertCalendarEvent,
  mapGoogleEvent,
  toGoogleTime,
} from "./lib/google";
import { googleEventIdForOperation } from "./lib/assistantLogic";
import { consumeRateLimit } from "./lib/rateLimit";
import { normalizeSlug, slugError } from "@qali/domain/slug";
import {
  MAX_EVENT_SPAN_MS,
  newRowBudget,
  spendRowBudget,
} from "./lib/eventReads";
import { getGoogleAccessToken } from "./lib/googleCredentials";
import { clearBookingNotifications } from "./notifications";

/** Settings a new page starts on: business hours, half-hour slots, two hours'
 * notice, two months ahead. */
const DEFAULT_PAGE = {
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
const MAX_SLOT_RANGE_MS = 35 * MS_PER_DAY;

const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_EMAIL = 3;
const MAX_REQUESTS_PER_PAGE = 20;
const MAX_PENDING_BOOKINGS = 500;
const EXPIRATION_BATCH_SIZE = 100;
const ACCEPT_LEASE_MS = 2 * 60 * 1000;

const slotSettingsValidator = {
  slotMinutes: v.number(),
  bufferMinutes: v.number(),
  minNoticeMinutes: v.number(),
  horizonDays: v.number(),
};

// --- Shared reads ---------------------------------------------------------

async function pageByUser(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"bookingPages"> | null> {
  return await ctx.db
    .query("bookingPages")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

async function pageBySlug(
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
async function collectBusy(
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
async function slotGrid(
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
  const firstKey = addDaysToDateKey(
    utcToZoned(fromMs, page.timeZone).dateKey,
    -1,
  );
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

// --- Host: the page and its schedule -------------------------------------

/** The signed-in host's own booking page, with every field they can edit. */
export const getMyBookingPage = query({
  args: {},
  handler: async (ctx): Promise<Doc<"bookingPages"> | null> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return null;
    }
    return await pageByUser(ctx, user._id);
  },
});

/** Whether `slug` is free for the caller to take. Requires a session: the
 * public page already reveals which slugs exist, but there is no reason to hand
 * anonymous callers a bulk name oracle. */
export const checkSlugAvailable = query({
  args: { slug: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ available: boolean; reason: string | null }> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return { available: false, reason: "Not authenticated" };
    }
    const slug = normalizeSlug(args.slug);
    const reason = slugError(slug);
    if (reason) {
      return { available: false, reason };
    }
    const existing = await pageBySlug(ctx, slug);
    if (existing && existing.userId !== user._id) {
      return { available: false, reason: "That link is already taken" };
    }
    return { available: true, reason: null };
  },
});

/**
 * Create or update the caller's booking page.
 *
 * `displayName` and `imageUrl` are copied from the auth user here rather than
 * read at request time, so the public page never has to touch the better-auth
 * component — which also holds the host's email.
 */
export const upsertBookingPage = mutation({
  args: {
    slug: v.string(),
    /** IANA zone the weekly rules are expressed in; the client sends its own. */
    timeZone: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    rules: v.array(
      v.object({
        weekday: v.number(),
        startMin: v.number(),
        endMin: v.number(),
      }),
    ),
    ...slotSettingsValidator,
    enabled: v.boolean(),
  },
  handler: async (ctx, args): Promise<{ slug: string }> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }

    const slug = normalizeSlug(args.slug);
    const reason = slugError(slug);
    if (reason) {
      throw new Error(reason);
    }
    const holder = await pageBySlug(ctx, slug);
    if (holder && holder.userId !== user._id) {
      throw new Error("That link is already taken");
    }

    for (const rule of args.rules) {
      if (rule.weekday < 0 || rule.weekday > 6) {
        throw new Error("Invalid weekday");
      }
      if (
        rule.startMin < 0 ||
        rule.endMin > 24 * 60 ||
        rule.endMin <= rule.startMin
      ) {
        throw new Error("Each opening must end after it starts");
      }
    }
    if (args.slotMinutes < 5 || args.slotMinutes > 8 * 60) {
      throw new Error("Slot length must be between 5 minutes and 8 hours");
    }
    if (args.bufferMinutes < 0 || args.minNoticeMinutes < 0) {
      throw new Error("Buffer and notice can't be negative");
    }
    if (args.horizonDays < 1 || args.horizonDays > 365) {
      throw new Error("Booking window must be between 1 and 365 days");
    }

    const value = {
      slug,
      displayName: user.name || user.email || "qali user",
      imageUrl: user.image ?? undefined,
      timeZone: args.timeZone,
      title: args.title,
      description: args.description,
      rules: args.rules,
      slotMinutes: args.slotMinutes,
      bufferMinutes: args.bufferMinutes,
      minNoticeMinutes: args.minNoticeMinutes,
      horizonDays: args.horizonDays,
      enabled: args.enabled,
    };

    const existing = await pageByUser(ctx, user._id);
    if (existing) {
      await ctx.db.patch(existing._id, value);
    } else {
      await ctx.db.insert("bookingPages", { userId: user._id, ...value });
    }
    return { slug };
  },
});

/** The defaults a first-time host starts from, so the panel can render a full
 * form before anything is saved. */
export const bookingPageDefaults = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    return {
      ...DEFAULT_PAGE,
      suggestedSlug: user ? normalizeSlug(user.email.split("@")[0] ?? "") : "",
      displayName: user?.name ?? "",
    };
  },
});

/**
 * Replace one date's hours. `intervals: []` blocks the day; passing no
 * `intervals` clears the override and hands the day back to the weekly rules.
 */
export const setOverride = mutation({
  args: {
    dateKey: v.string(),
    intervals: v.optional(
      v.array(v.object({ startMin: v.number(), endMin: v.number() })),
    ),
  },
  handler: async (ctx, args): Promise<null> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.dateKey)) {
      throw new Error("Invalid date");
    }
    for (const interval of args.intervals ?? []) {
      if (!isValidDayInterval(interval)) {
        throw new Error(
          "Each interval must use whole minutes within the day and end after it starts",
        );
      }
    }
    const existing = await ctx.db
      .query("availabilityOverrides")
      .withIndex("by_user_and_date", (q) =>
        q.eq("userId", user._id).eq("dateKey", args.dateKey),
      )
      .unique();

    if (!args.intervals) {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    const intervals = mergeDayIntervals(args.intervals);
    if (existing) {
      await ctx.db.patch(existing._id, { intervals });
    } else {
      await ctx.db.insert("availabilityOverrides", {
        userId: user._id,
        dateKey: args.dateKey,
        intervals,
      });
    }
    return null;
  },
});

/** The caller's date overrides, for the availability panel. */
export const listMyOverrides = query({
  args: {},
  handler: async (ctx): Promise<Doc<"availabilityOverrides">[]> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    return await ctx.db
      .query("availabilityOverrides")
      .withIndex("by_user_and_date", (q) => q.eq("userId", user._id))
      .collect();
  },
});

/** Requests overlapping `[startMs, endMs)`, for the grid layer and the dock.
 * Every status is returned; the caller decides what to show. */
export const listMyBookings = query({
  args: { startMs: v.number(), endMs: v.number() },
  handler: async (ctx, args): Promise<Doc<"bookings">[]> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    const budget = newRowBudget();
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_host_and_end", (q) =>
        q
          .eq("hostUserId", user._id)
          .gt("endMs", args.startMs)
          .lte("endMs", args.endMs + MAX_EVENT_SPAN_MS),
      )
      .take(budget.remaining + 1);
    spendRowBudget(budget, rows.length);
    return rows
      .filter((b) => b.startMs < args.endMs)
      .sort((a, b) => a.startMs - b.startMs);
  },
});

/** Pending requests ordered by start time. Expiration mutations keep this
 * deterministic query current without reading the wall clock here. */
export const listPendingBookings = query({
  args: {},
  handler: async (ctx): Promise<Doc<"bookings">[]> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_host_and_status_and_start", (q) =>
        q.eq("hostUserId", user._id).eq("status", "pending"),
      )
      .order("asc")
      .take(MAX_PENDING_BOOKINGS);
    return rows;
  },
});

/** Expire one request at its scheduled end. A decision that won the race first
 * is left untouched. */
export const expireBooking = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<null> => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.status !== "pending" ||
      booking.endMs > Date.now() ||
      (booking.acceptAttemptId &&
        (booking.acceptLeaseExpiresAt ?? 0) > Date.now())
    ) {
      return null;
    }
    await ctx.db.patch(args.bookingId, { status: "expired" });
    await clearBookingNotifications(ctx, args.bookingId);
    return null;
  },
});

/** Backfill requests created before per-booking expiration was introduced and
 * recover in bounded batches if scheduled work was ever missed. */
export const expirePastBookings = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_status_and_end", (q) =>
        q.eq("status", "pending").lte("endMs", Date.now()),
      )
      .take(EXPIRATION_BATCH_SIZE);

    for (const booking of rows) {
      if (
        booking.acceptAttemptId &&
        (booking.acceptLeaseExpiresAt ?? 0) > Date.now()
      ) {
        continue;
      }
      await ctx.db.patch(booking._id, { status: "expired" });
      await clearBookingNotifications(ctx, booking._id);
    }
    if (rows.length === EXPIRATION_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.booking.expirePastBookings,
        {},
      );
    }
    return null;
  },
});

// --- Public: the booking page itself --------------------------------------

/**
 * The public face of a booking page. Returns only what the page renders — never
 * the host's `userId` or email, and never anything about their events.
 */
export const getPublicPage = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const page = await pageBySlug(ctx, normalizeSlug(args.slug));
    if (!page || !page.enabled) {
      return null;
    }
    return {
      slug: page.slug,
      displayName: page.displayName,
      imageUrl: page.imageUrl,
      timeZone: page.timeZone,
      title: page.title,
      description: page.description,
      slotMinutes: page.slotMinutes,
      minNoticeMinutes: page.minNoticeMinutes,
      horizonDays: page.horizonDays,
    };
  },
});

/**
 * The slot grid in `[fromMs, toMs)`. Slot starts, a taken/free flag, and the
 * slot length are the entire payload: a visitor can tell that the host is free
 * at 10:00 and busy at 11:00, and nothing more — not what the 11:00 is, who it
 * is with, or whether it is a meeting at all.
 *
 * Taken slots are sent rather than filtered out so the picker can disable them
 * in place. The gaps in an open-only list already gave the same times away; this
 * only stops a visitor from choosing one and being refused on submit.
 */
export const listSlots = query({
  args: { slug: v.string(), fromMs: v.number(), toMs: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ slotMinutes: number; slots: SlotOption[] }> => {
    const page = await pageBySlug(ctx, normalizeSlug(args.slug));
    if (!page || !page.enabled) {
      return { slotMinutes: 0, slots: [] };
    }
    const fromMs = args.fromMs;
    const toMs = Math.min(args.toMs, fromMs + MAX_SLOT_RANGE_MS);
    if (toMs <= fromMs) {
      return { slotMinutes: page.slotMinutes, slots: [] };
    }
    return {
      slotMinutes: page.slotMinutes,
      slots: await slotGrid(ctx, page, fromMs, toMs),
    };
  },
});

/**
 * Request one of the host's open slots. Anonymous callers reach this, so the
 * slot is re-derived here and `startMs` has to match one the server itself
 * offers — the visitor's list is only a suggestion.
 */
/** A short, human date range for a booking notification, in the host's zone —
 * e.g. "Mon, Aug 4 · 2:00 – 2:30 PM". Display only. */
function bookingNotificationBody(
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

export const requestBooking = mutation({
  args: {
    slug: v.string(),
    startMs: v.number(),
    name: v.string(),
    email: v.string(),
    note: v.optional(v.string()),
    /** The visitor's IANA zone, recorded so the host can see what time they
     * thought they were booking. Display only. */
    timeZone: v.string(),
  },
  handler: async (ctx, args): Promise<{ token: string }> => {
    const page = await pageBySlug(ctx, normalizeSlug(args.slug));
    if (!page || !page.enabled) {
      throw new Error("This booking link isn't available");
    }

    const name = args.name.trim();
    const email = args.email.trim().toLowerCase();
    if (name.length < 1 || name.length > 100) {
      throw new Error("Please enter your name");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
      throw new Error("Please enter a valid email address");
    }
    const note = args.note?.trim();
    if (note && note.length > 2000) {
      throw new Error("Please shorten your message");
    }

    if (
      !(await consumeRateLimit(
        ctx,
        `page:${page.slug}`,
        MAX_REQUESTS_PER_PAGE,
        RATE_WINDOW_MS,
      ))
    ) {
      throw new ConvexError({ code: "PAGE_RATE_LIMIT" });
    }
    if (
      !(await consumeRateLimit(
        ctx,
        `email:${email}`,
        MAX_REQUESTS_PER_EMAIL,
        RATE_WINDOW_MS,
      ))
    ) {
      throw new ConvexError({ code: "EMAIL_RATE_LIMIT" });
    }

    // Ask for a window just wide enough to contain the requested slot, so the
    // check is cheap but still runs the same rules as the listing.
    const endMs = args.startMs + page.slotMinutes * 60_000;
    const slots = await slotGrid(
      ctx,
      page,
      args.startMs - MS_PER_DAY,
      endMs + MS_PER_DAY,
    );
    const slot = slots.find((s) => s.startMs === args.startMs);
    if (!slot?.available) {
      throw new Error("That time is no longer available");
    }

    const token = crypto.randomUUID();
    const bookingId = await ctx.db.insert("bookings", {
      hostUserId: page.userId,
      startMs: args.startMs,
      endMs,
      timeZone: args.timeZone,
      requesterName: name,
      requesterEmail: email,
      note: note || undefined,
      status: "pending",
      token,
      createdAt: Date.now(),
    });
    // Surface the request in the host's notification bell. Times render in the
    // host's page zone so the body reads the same as the booking panel.
    await ctx.db.insert("notifications", {
      userId: page.userId,
      type: "booking_requested",
      title: `New booking request from ${name}`,
      body: bookingNotificationBody(args.startMs, endMs, page.timeZone),
      bookingId,
      read: false,
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAt(endMs, internal.booking.expireBooking, {
      bookingId,
    });
    return { token };
  },
});

/** A requester following their own request. The token is the authorization, so
 * this returns only what the confirmation screen shows. */
export const getBookingByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const booking = await ctx.db
      .query("bookings")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!booking) {
      return null;
    }
    const page = await pageByUser(ctx, booking.hostUserId);
    return {
      status: booking.status,
      startMs: booking.startMs,
      endMs: booking.endMs,
      requesterName: booking.requesterName,
      hostName: page?.displayName ?? "the host",
      // The meeting's own title, so a downloaded/added calendar event carries it
      // rather than a generic label. Falls back on the client when unset.
      title: page?.title,
    };
  },
});

// --- Host: accept and reject ---------------------------------------------

/** The booking plus its host's page, for the accept action. */
export const getBookingContext = internalQuery({
  args: { bookingId: v.id("bookings"), hostUserId: v.string() },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking || booking.hostUserId !== args.hostUserId) {
      return null;
    }
    const page = await pageByUser(ctx, args.hostUserId);
    if (!page) {
      return null;
    }
    // Whether anything *else* now occupies the slot. A request can sit pending
    // while the host books the time by hand, and Google would happily
    // double-book it.
    const busy = await collectBusy(
      ctx,
      page,
      booking.startMs,
      booking.endMs,
      booking._id,
    );
    const conflict = busy.some(
      (b) => b.startMs < booking.endMs && b.endMs > booking.startMs,
    );
    return { booking, page, conflict };
  },
});

/** Stamp the accepted booking with the Google event it produced. */
export const markAccepted = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hostUserId: v.string(),
    googleEventId: v.string(),
    calendarId: v.string(),
    attemptId: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.hostUserId !== args.hostUserId ||
      booking.status !== "pending" ||
      booking.acceptAttemptId !== args.attemptId
    ) {
      return false;
    }
    await ctx.db.patch(args.bookingId, {
      status: "accepted",
      googleEventId: args.googleEventId,
      calendarId: args.calendarId,
      decidedAt: Date.now(),
      acceptAttemptId: undefined,
      acceptLeaseExpiresAt: undefined,
      acceptMayHaveSucceeded: undefined,
    });
    await clearBookingNotifications(ctx, args.bookingId);
    return true;
  },
});

/** Claim acceptance and recheck the slot in the same transaction. Booking-row
 * changes that could create a conflicting acceptance now race here, not at
 * Google. A stable operation ID remains after uncertain failures. */
export const claimBookingAcceptance = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hostUserId: v.string(),
    attemptId: v.string(),
    calendarId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const booking = await ctx.db.get(args.bookingId);
    if (
      !booking ||
      booking.hostUserId !== args.hostUserId ||
      booking.status !== "pending" ||
      booking.endMs <= now
    ) {
      return null;
    }
    if (
      booking.acceptAttemptId &&
      (booking.acceptLeaseExpiresAt ?? 0) > now
    ) {
      return null;
    }
    const page = await pageByUser(ctx, args.hostUserId);
    if (!page) return null;
    const operationId = booking.acceptOperationId ?? crypto.randomUUID();
    const busy = await collectBusy(
      ctx,
      page,
      booking.startMs,
      booking.endMs,
      booking._id,
      googleEventIdForOperation(operationId),
    );
    if (
      busy.some(
        (span) =>
          span.startMs < booking.endMs && span.endMs > booking.startMs,
      )
    ) {
      throw new Error("That time is no longer free on your calendar");
    }
    const calendarId = booking.calendarId ?? args.calendarId;
    await ctx.db.patch(booking._id, {
      acceptOperationId: operationId,
      acceptAttemptId: args.attemptId,
      acceptLeaseExpiresAt: now + ACCEPT_LEASE_MS,
      // Conservative until a known Google failure clears it. If this action
      // disappears, rejection cannot contradict a possibly sent invitation.
      acceptMayHaveSucceeded: true,
      calendarId,
    });
    return { booking, page, operationId, calendarId };
  },
});

export const releaseBookingAcceptance = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hostUserId: v.string(),
    attemptId: v.string(),
    mayHaveSucceeded: v.boolean(),
  },
  handler: async (ctx, args): Promise<null> => {
    const booking = await ctx.db.get(args.bookingId);
    if (
      booking?.hostUserId === args.hostUserId &&
      booking.status === "pending" &&
      booking.acceptAttemptId === args.attemptId
    ) {
      await ctx.db.patch(booking._id, {
        acceptAttemptId: undefined,
        acceptLeaseExpiresAt: undefined,
        acceptMayHaveSucceeded: args.mayHaveSucceeded,
      });
    }
    return null;
  },
});

/**
 * Accept a request: write it to the host's Google Calendar with the requester as
 * a guest and `sendUpdates: "all"`, which is what actually delivers the
 * confirmation — we send no mail of our own.
 *
 * An action rather than a mutation because it talks to Google. It reuses the
 * same sequence as `calendar.createEvent`: resolve a token through better-auth,
 * pick the primary calendar, insert, then mirror the row so the card appears now
 * instead of at the next 15-minute sync.
 */
export const acceptBooking = action({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx: ActionCtx, args): Promise<null> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }

    const accessToken = await getGoogleAccessToken(ctx, user._id);

    const calendarId =
      (await ctx.runQuery(internal.calendar.getPrimaryCalendarId, {
        userId: user._id,
      })) ?? "primary";
    const attemptId = crypto.randomUUID();
    const claimed = await ctx.runMutation(
      internal.booking.claimBookingAcceptance,
      {
        bookingId: args.bookingId,
        hostUserId: user._id,
        attemptId,
        calendarId,
      },
    );
    if (!claimed) {
      const context = await ctx.runQuery(internal.booking.getBookingContext, {
        bookingId: args.bookingId,
        hostUserId: user._id,
      });
      if (context?.booking.status === "accepted") return null;
      throw new Error("This request is unavailable or already being answered");
    }
    const {
      booking,
      page,
      operationId,
      calendarId: claimedCalendarId,
    } = claimed;

    const label = page.title?.trim() || "Meeting";
    const requestedGoogleEventId = googleEventIdForOperation(operationId);
    let event;
    try {
      try {
        event = await insertCalendarEvent(
          accessToken,
          claimedCalendarId,
          {
            id: requestedGoogleEventId,
            summary: `${label} with ${booking.requesterName}`,
            description: booking.note
              ? `Booked via qali.\n\n${booking.note}`
              : "Booked via qali.",
            start: toGoogleTime(booking.startMs, false, page.timeZone),
            end: toGoogleTime(booking.endMs, false, page.timeZone),
            attendees: [
              {
                email: booking.requesterEmail,
                displayName: booking.requesterName,
              },
            ],
          },
          // Google owns the invitation email; this is what sends it.
          "all",
        );
      } catch (error) {
        if (!(error instanceof GoogleApiError) || error.status !== 409) throw error;
        event = mapGoogleEvent(
          await getCalendarEvent(
            accessToken,
            claimedCalendarId,
            requestedGoogleEventId,
          ),
          claimedCalendarId,
        );
      }

      const marked = await ctx.runMutation(internal.booking.markAccepted, {
        bookingId: args.bookingId,
        hostUserId: user._id,
        googleEventId: event.googleEventId,
        calendarId: claimedCalendarId,
        attemptId,
      });
      if (!marked) throw new Error("Booking acceptance claim was lost");
    } catch (error) {
      await ctx.runMutation(internal.booking.releaseBookingAcceptance, {
        bookingId: args.bookingId,
        hostUserId: user._id,
        attemptId,
        mayHaveSucceeded:
          event !== undefined || error instanceof GoogleNetworkError,
      });
      if (event) {
        throw new Error(
          `Google accepted the booking, but local confirmation is pending. Retry acceptance to reconcile it safely. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }

    // The booking state and Google event are authoritative. A sync repairs this
    // optional optimistic mirror if the local write is transiently unavailable.
    try {
      await ctx.runMutation(internal.calendar.upsertEvent, {
        userId: user._id,
        event,
      });
    } catch (error) {
      console.error("[booking] Google accepted event; mirror pending", error);
    }
    return null;
  },
});

/** Decline a request. A mutation, not an action: nothing reaches Google, and the
 * requester learns of it from their own confirmation link. */
export const rejectBooking = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<null> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    const booking = await ctx.db.get(args.bookingId);
    if (!booking || booking.hostUserId !== user._id) {
      throw new Error("Request not found");
    }
    if (booking.status === "rejected") {
      return null;
    }
    if (booking.status === "expired") {
      throw new Error("This request has expired");
    }
    if (booking.status !== "pending") {
      throw new Error("This request has already been answered");
    }
    if (
      booking.acceptAttemptId &&
      (booking.acceptLeaseExpiresAt ?? 0) > Date.now()
    ) {
      throw new Error("This request is currently being accepted");
    }
    if (booking.acceptMayHaveSucceeded) {
      throw new Error(
        "A previous acceptance may have reached Google. Retry acceptance to reconcile it before rejecting.",
      );
    }
    if (booking.endMs <= Date.now()) {
      throw new Error("This request has expired");
    }
    await ctx.db.patch(args.bookingId, {
      status: "rejected",
      decidedAt: Date.now(),
    });
    await clearBookingNotifications(ctx, args.bookingId);
    return null;
  },
});
