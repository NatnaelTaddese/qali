/** Read handlers for the booking domain. Plain functions; the root `booking.ts`
 * wraps each in a Convex `query` / `internalQuery`. */

import type { SlotOption } from "@qali/domain/availability";
import { normalizeSlug, slugError } from "@qali/domain/slug";

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  MAX_EVENT_SPAN_MS,
  newRowBudget,
  spendRowBudget,
} from "../../shared/eventReads";
import {
  collectBusy,
  DEFAULT_PAGE,
  MAX_PENDING_BOOKINGS,
  MAX_SLOT_RANGE_MS,
  pageBySlug,
  pageByUser,
  slotGrid,
} from "./model";

/** The signed-in host's own booking page, with every field they can edit. */
export async function getMyBookingPageHandler(
  ctx: QueryCtx,
): Promise<Doc<"bookingPages"> | null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return null;
  }
  return await pageByUser(ctx, user._id);
}

/** Whether `slug` is free for the caller to take. Requires a session: the
 * public page already reveals which slugs exist, but there is no reason to hand
 * anonymous callers a bulk name oracle. */
export async function checkSlugAvailableHandler(
  ctx: QueryCtx,
  args: { slug: string },
): Promise<{ available: boolean; reason: string | null }> {
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
}

/** The defaults a first-time host starts from, so the panel can render a full
 * form before anything is saved. */
export async function bookingPageDefaultsHandler(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  return {
    ...DEFAULT_PAGE,
    suggestedSlug: user ? normalizeSlug(user.email.split("@")[0] ?? "") : "",
    displayName: user?.name ?? "",
  };
}

/** The caller's date overrides, for the availability panel. */
export async function listMyOverridesHandler(
  ctx: QueryCtx,
): Promise<Doc<"availabilityOverrides">[]> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return [];
  }
  return await ctx.db
    .query("availabilityOverrides")
    .withIndex("by_user_and_date", (q) => q.eq("userId", user._id))
    .collect();
}

/** Requests overlapping `[startMs, endMs)`, for the grid layer and the dock.
 * Every status is returned; the caller decides what to show. */
export async function listMyBookingsHandler(
  ctx: QueryCtx,
  args: { startMs: number; endMs: number },
): Promise<Doc<"bookings">[]> {
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
}

/** Pending requests ordered by start time. Expiration mutations keep this
 * deterministic query current without reading the wall clock here. */
export async function listPendingBookingsHandler(
  ctx: QueryCtx,
): Promise<Doc<"bookings">[]> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return [];
  }
  return await ctx.db
    .query("bookings")
    .withIndex("by_host_and_status_and_start", (q) =>
      q.eq("hostUserId", user._id).eq("status", "pending"),
    )
    .order("asc")
    .take(MAX_PENDING_BOOKINGS);
}

/**
 * The public face of a booking page. Returns only what the page renders — never
 * the host's `userId` or email, and never anything about their events.
 */
export async function getPublicPageHandler(
  ctx: QueryCtx,
  args: { slug: string },
) {
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
}

/**
 * The slot grid in `[fromMs, toMs)`. Slot starts, a taken/free flag, and the
 * slot length are the entire payload: a visitor can tell that the host is free
 * at 10:00 and busy at 11:00, and nothing more.
 *
 * Taken slots are sent rather than filtered out so the picker can disable them
 * in place.
 */
export async function listSlotsHandler(
  ctx: QueryCtx,
  args: { slug: string; fromMs: number; toMs: number; nowMs?: number },
): Promise<{ slotMinutes: number; slots: SlotOption[] }> {
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
    // `fromMs` was already caller-materialized by legacy clients, so it is a
    // safe compatibility fallback that does not introduce a reactive wall clock.
    slots: await slotGrid(ctx, page, fromMs, toMs, args.nowMs ?? fromMs),
  };
}

/** A requester following their own request. The token is the authorization, so
 * this returns only what the confirmation screen shows. */
export async function getBookingByTokenHandler(
  ctx: QueryCtx,
  args: { token: string },
) {
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
}

/** Whether anything else now occupies a pending booking's slot — a request can
 * sit pending while the host books the time by hand. Used by the accept path. */
export async function getBookingContextHandler(
  ctx: QueryCtx,
  args: { bookingId: Id<"bookings">; hostUserId: string },
) {
  const booking = await ctx.db.get(args.bookingId);
  if (!booking || booking.hostUserId !== args.hostUserId) {
    return null;
  }
  const page = await pageByUser(ctx, args.hostUserId);
  if (!page) {
    return null;
  }
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
  const acceptanceOperation = await ctx.db
    .query("calendarOperations")
    .withIndex("by_bookingId", (q) => q.eq("bookingId", booking._id))
    .unique();
  return { booking, page, conflict, acceptanceOperation };
}
