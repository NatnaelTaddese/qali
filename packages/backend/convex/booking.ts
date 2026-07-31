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
import { authComponent, createAuth } from "./auth";
import {
  allDayBusyInterval,
  generateSlotGrid,
  type Interval,
  MS_PER_DAY,
  type SlotOption,
} from "./lib/availability";
import { insertCalendarEvent, toGoogleTime } from "./lib/google";
import { normalizeSlug, slugError } from "./lib/slug";

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

/** The `events` index is on `startMs`, so scan back a day to catch events that
 * begin before the window and overlap into it. Same trade-off (and same
 * accepted limitation for events longer than a day) as `calendar.listEventsInRange`. */
const LOOKBACK_MS = MS_PER_DAY;

const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_EMAIL = 3;
const MAX_REQUESTS_PER_PAGE = 20;
const MAX_PENDING_BOOKINGS = 500;
const EXPIRATION_BATCH_SIZE = 100;

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
): Promise<Interval[]> {
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", page.userId))
    .collect();
  const visible = new Set(
    calendars.filter((c) => c.selected).map((c) => c.googleCalendarId),
  );

  const events = await ctx.db
    .query("events")
    .withIndex("by_user_and_start", (q) =>
      q
        .eq("userId", page.userId)
        .gte("startMs", fromMs - LOOKBACK_MS)
        .lt("startMs", toMs),
    )
    .collect();

  const busy: Interval[] = [];
  for (const event of events) {
    if (event.status === "cancelled") continue;
    // The host marked this one "free" in their own calendar, so it is not a
    // reason to withhold the time.
    if (event.transparency === "transparent") continue;
    if (!visible.has(event.calendarId)) continue;
    if (event.endMs <= fromMs) continue;
    busy.push(
      event.allDay
        ? allDayBusyInterval(event.startMs, event.endMs, page.timeZone)
        : { startMs: event.startMs, endMs: event.endMs },
    );
  }

  const bookings = await ctx.db
    .query("bookings")
    .withIndex("by_host_and_start", (q) =>
      q
        .eq("hostUserId", page.userId)
        .gte("startMs", fromMs - LOOKBACK_MS)
        .lt("startMs", toMs),
    )
    .collect();

  for (const booking of bookings) {
    if (booking.status === "rejected" || booking.status === "expired") continue;
    if (booking._id === excludeBookingId) continue;
    if (booking.endMs <= fromMs) continue;
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
  const overrides = await ctx.db
    .query("availabilityOverrides")
    .withIndex("by_user_and_date", (q) => q.eq("userId", page.userId))
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
    if (existing) {
      await ctx.db.patch(existing._id, { intervals: args.intervals });
    } else {
      await ctx.db.insert("availabilityOverrides", {
        userId: user._id,
        dateKey: args.dateKey,
        intervals: args.intervals,
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
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_host_and_start", (q) =>
        q
          .eq("hostUserId", user._id)
          .gte("startMs", args.startMs - LOOKBACK_MS)
          .lt("startMs", args.endMs),
      )
      .order("asc")
      .collect();
    return rows.filter((b) => b.endMs > args.startMs);
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
      booking.endMs > Date.now()
    ) {
      return null;
    }
    await ctx.db.patch(args.bookingId, { status: "expired" });
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
      await ctx.db.patch(booking._id, { status: "expired" });
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
 * Fixed-window counter. Returns false when `key` has already used up `limit`
 * requests in the current hour.
 *
 * Rough by design: a Convex mutation sees no client IP, so the keys available
 * are the requester's email and the page itself. Moving `requestBooking` behind
 * an `httpAction` would add an IP key if that ever proves too weak.
 */
async function consumeRateLimit(
  ctx: MutationCtx,
  key: string,
  limit: number,
): Promise<boolean> {
  const now = Date.now();
  const row = await ctx.db
    .query("bookingRateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

  if (!row) {
    await ctx.db.insert("bookingRateLimits", {
      key,
      windowStartMs: now,
      count: 1,
    });
    return true;
  }
  if (now - row.windowStartMs >= RATE_WINDOW_MS) {
    await ctx.db.patch(row._id, { windowStartMs: now, count: 1 });
    return true;
  }
  if (row.count >= limit) {
    return false;
  }
  await ctx.db.patch(row._id, { count: row.count + 1 });
  return true;
}

/**
 * Request one of the host's open slots. Anonymous callers reach this, so the
 * slot is re-derived here and `startMs` has to match one the server itself
 * offers — the visitor's list is only a suggestion.
 */
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

    if (!(await consumeRateLimit(ctx, `page:${page.slug}`, MAX_REQUESTS_PER_PAGE))) {
      throw new ConvexError({ code: "PAGE_RATE_LIMIT" });
    }
    if (!(await consumeRateLimit(ctx, `email:${email}`, MAX_REQUESTS_PER_EMAIL))) {
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
  },
  handler: async (ctx, args): Promise<null> => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking || booking.hostUserId !== args.hostUserId) {
      return null;
    }
    await ctx.db.patch(args.bookingId, {
      status: "accepted",
      googleEventId: args.googleEventId,
      calendarId: args.calendarId,
      decidedAt: Date.now(),
    });
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

    const context = await ctx.runQuery(internal.booking.getBookingContext, {
      bookingId: args.bookingId,
      hostUserId: user._id,
    });
    if (!context) {
      throw new Error("Request not found");
    }
    const { booking, page, conflict } = context;
    if (booking.status === "expired") {
      throw new Error("This request has expired");
    }
    if (booking.status !== "pending") {
      throw new Error("This request has already been answered");
    }
    if (booking.endMs <= Date.now()) {
      throw new Error("This request has expired");
    }
    if (conflict) {
      throw new Error("That time is no longer free on your calendar");
    }

    const { accessToken } = await createAuth(ctx).api.getAccessToken({
      body: { providerId: "google", userId: user._id },
    });
    if (!accessToken) {
      throw new Error("No Google access token available for user");
    }

    const calendarId =
      (await ctx.runQuery(internal.calendar.getPrimaryCalendarId, {
        userId: user._id,
      })) ?? "primary";

    const label = page.title?.trim() || "Meeting";
    const event = await insertCalendarEvent(
      accessToken,
      calendarId,
      {
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

    await ctx.runMutation(internal.calendar.upsertEvent, {
      userId: user._id,
      event,
    });
    await ctx.runMutation(internal.booking.markAccepted, {
      bookingId: args.bookingId,
      hostUserId: user._id,
      googleEventId: event.googleEventId,
      calendarId,
    });
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
    if (booking.status === "expired") {
      throw new Error("This request has expired");
    }
    if (booking.status !== "pending") {
      throw new Error("This request has already been answered");
    }
    if (booking.endMs <= Date.now()) {
      throw new Error("This request has expired");
    }
    await ctx.db.patch(args.bookingId, {
      status: "rejected",
      decidedAt: Date.now(),
    });
    return null;
  },
});
