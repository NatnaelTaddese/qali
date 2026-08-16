/** Write handlers for the booking domain. Plain functions; the root `booking.ts`
 * wraps each in a Convex `mutation` / `internalMutation`. The acceptance-claim
 * lease and the expiry continuations reschedule through those stable paths. */

import {
  isValidDayInterval,
  mergeDayIntervals,
  MS_PER_DAY,
} from "@qali/domain/availability";
import { normalizeSlug, slugError } from "@qali/domain/slug";
import { ConvexError } from "convex/values";

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import { googleEventIdForOperation } from "../../lib/assistantLogic";
import { consumeRateLimit } from "../../infrastructure/rateLimit";
import { ensureGoogleConnection } from "../calendar/connections";
import { clearBookingNotifications } from "../notifications/model";
import {
  ACCEPT_LEASE_MS,
  bookingNotificationBody,
  collectBusy,
  EXPIRATION_BATCH_SIZE,
  MAX_REQUESTS_PER_EMAIL,
  MAX_REQUESTS_PER_PAGE,
  pageBySlug,
  pageByUser,
  RATE_WINDOW_MS,
  slotGrid,
} from "./model";

export async function upsertBookingPageHandler(
  ctx: MutationCtx,
  args: {
    slug: string;
    timeZone: string;
    title?: string;
    description?: string;
    rules: { weekday: number; startMin: number; endMin: number }[];
    slotMinutes: number;
    bufferMinutes: number;
    minNoticeMinutes: number;
    horizonDays: number;
    enabled: boolean;
  },
): Promise<{ slug: string }> {
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
}

export async function setOverrideHandler(
  ctx: MutationCtx,
  args: { dateKey: string; intervals?: { startMin: number; endMin: number }[] },
): Promise<null> {
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
}

export async function requestBookingHandler(
  ctx: MutationCtx,
  args: {
    slug: string;
    startMs: number;
    name: string;
    email: string;
    note?: string;
    timeZone: string;
  },
): Promise<{ token: string }> {
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
  // Dual-write: stamp the host's connection so the row matches the backfilled
  // ones. providerEventId is set later, when acceptance creates the event.
  const connectionId = await ensureGoogleConnection(ctx, page.userId);
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
    connectionId,
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
}

/** Expire one request at its scheduled end. A decision that won the race first
 * is left untouched. */
export async function expireBookingHandler(
  ctx: MutationCtx,
  args: { bookingId: Id<"bookings"> },
): Promise<null> {
  const booking = await ctx.db.get(args.bookingId);
  if (
    !booking ||
    booking.status !== "pending" ||
    booking.endMs > Date.now() ||
    (booking.acceptAttemptId && (booking.acceptLeaseExpiresAt ?? 0) > Date.now())
  ) {
    return null;
  }
  await ctx.db.patch(args.bookingId, { status: "expired" });
  await clearBookingNotifications(ctx, args.bookingId);
  return null;
}

/** Backfill requests created before per-booking expiration was introduced and
 * recover in bounded batches if scheduled work was ever missed. */
export async function expirePastBookingsHandler(
  ctx: MutationCtx,
): Promise<null> {
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
    await ctx.scheduler.runAfter(0, internal.booking.expirePastBookings, {});
  }
  return null;
}

/** Stamp the accepted booking with the Google event it produced. */
export async function markAcceptedHandler(
  ctx: MutationCtx,
  args: {
    bookingId: Id<"bookings">;
    hostUserId: string;
    googleEventId: string;
    calendarId: string;
    attemptId: string;
  },
): Promise<boolean> {
  const booking = await ctx.db.get(args.bookingId);
  if (
    !booking ||
    booking.hostUserId !== args.hostUserId ||
    booking.status !== "pending" ||
    booking.acceptAttemptId !== args.attemptId
  ) {
    return false;
  }
  // Dual-write the neutral mirror of the created event alongside the Google id.
  const connectionId = await ensureGoogleConnection(ctx, args.hostUserId);
  await ctx.db.patch(args.bookingId, {
    status: "accepted",
    googleEventId: args.googleEventId,
    calendarId: args.calendarId,
    connectionId,
    providerEventId: args.googleEventId,
    decidedAt: Date.now(),
    acceptAttemptId: undefined,
    acceptLeaseExpiresAt: undefined,
    acceptMayHaveSucceeded: undefined,
  });
  await clearBookingNotifications(ctx, args.bookingId);
  return true;
}

/** Claim acceptance and recheck the slot in the same transaction. Booking-row
 * changes that could create a conflicting acceptance now race here, not at
 * Google. A stable operation ID remains after uncertain failures. */
export async function claimBookingAcceptanceHandler(
  ctx: MutationCtx,
  args: {
    bookingId: Id<"bookings">;
    hostUserId: string;
    attemptId: string;
    calendarId: string;
  },
) {
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
  if (booking.acceptAttemptId && (booking.acceptLeaseExpiresAt ?? 0) > now) {
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
      (span) => span.startMs < booking.endMs && span.endMs > booking.startMs,
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
}

export async function releaseBookingAcceptanceHandler(
  ctx: MutationCtx,
  args: {
    bookingId: Id<"bookings">;
    hostUserId: string;
    attemptId: string;
    mayHaveSucceeded: boolean;
  },
): Promise<null> {
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
}

/** Decline a request. A mutation, not an action: nothing reaches Google, and the
 * requester learns of it from their own confirmation link. */
export async function rejectBookingHandler(
  ctx: MutationCtx,
  args: { bookingId: Id<"bookings"> },
): Promise<null> {
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
}
