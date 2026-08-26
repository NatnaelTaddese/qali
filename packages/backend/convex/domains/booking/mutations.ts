/** Booking domain writes. Canonical registration for the booking mutations.
 * The acceptance-claim lease and the expiry continuations reschedule through
 * the canonical `internal.domains.booking.*` paths. */

import {
  isValidDayInterval,
  mergeDayIntervals,
  MS_PER_DAY,
} from "@qali/domain/availability";
import { normalizeSlug, slugError } from "@qali/domain/slug";
import { ConvexError, v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "../../_generated/server";
import { authComponent } from "../../auth";
import { consumeRateLimit } from "../../infrastructure/rateLimit";
import {
  ensureDefaultPrimaryCalendar,
  ensureGoogleConnection,
} from "../calendar/connections";
import { calendarRequestFingerprint } from "../calendar/operationIdentity";
import { clearBookingNotifications } from "../notifications/model";
import {
  ACCEPT_LEASE_MS,
  ACCEPT_RECONCILE_BASE_DELAY_MS,
  ACCEPT_RECONCILE_MAX_ATTEMPTS,
  bookingNotificationBody,
  collectBusy,
  EXPIRATION_BATCH_SIZE,
  MAX_REQUESTS_PER_EMAIL,
  MAX_REQUESTS_PER_PAGE,
  pageBySlug,
  pageByUser,
  RATE_WINDOW_MS,
  slotGrid,
  slotSettingsValidator,
} from "./model";

async function primaryLocalCalendar(
  ctx: MutationCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
) {
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(501);
  if (calendars.length > 500) {
    throw new Error("Too many calendars to choose a booking target safely");
  }
  return calendars.find(
    (row) => row.primary === true && row.connectionId === connectionId,
  );
}

type BookingTarget = {
  connection: Doc<"calendarConnections">;
  calendar: Doc<"calendars">;
  providerCalendarId: string;
};

function calendarIsWritable(calendar: Doc<"calendars">): boolean {
  return (
    calendar.accessRole === "owner" ||
    calendar.accessRole === "writer" ||
    (calendar.primary === true && calendar.accessRole === undefined)
  );
}

async function validateBookingTarget(
  ctx: MutationCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
  localCalendarId: Id<"calendars">,
  expectedProviderCalendarId?: string,
): Promise<BookingTarget> {
  const connection = await ctx.db.get(connectionId);
  const calendar = await ctx.db.get(localCalendarId);
  const providerCalendarId = calendar?.providerCalendarId;
  if (
    !connection ||
    connection.userId !== userId ||
    connection.status !== "active" ||
    !calendar ||
    !providerCalendarId ||
    calendar.userId !== userId ||
    !calendarIsWritable(calendar) ||
    calendar.connectionId !== connection._id ||
    (expectedProviderCalendarId !== undefined &&
      providerCalendarId !== expectedProviderCalendarId)
  ) {
    throw new Error("Booking calendar target is unavailable");
  }
  return {
    connection,
    calendar,
    providerCalendarId,
  };
}

async function primaryGoogleBookingTarget(
  ctx: MutationCtx,
  userId: string,
): Promise<BookingTarget> {
  const connectionId = await ensureGoogleConnection(ctx, userId);
  const calendar =
    (await primaryLocalCalendar(ctx, userId, connectionId)) ??
    (await ensureDefaultPrimaryCalendar(ctx, userId, connectionId));
  return await validateBookingTarget(ctx, userId, connectionId, calendar._id);
}

async function bookingPageTarget(
  ctx: MutationCtx,
  page: Doc<"bookingPages">,
): Promise<BookingTarget> {
  if (page.targetConnectionId && page.targetCalendarId) {
    return await validateBookingTarget(
      ctx,
      page.userId,
      page.targetConnectionId,
      page.targetCalendarId,
    );
  }
  if (page.targetConnectionId || page.targetCalendarId) {
    throw new Error("Booking calendar target is unavailable");
  }
  const target = await primaryGoogleBookingTarget(ctx, page.userId);
  await ctx.db.patch(page._id, {
    targetConnectionId: target.connection._id,
    targetCalendarId: target.calendar._id,
  });
  return target;
}

async function operationForBooking(
  ctx: MutationCtx,
  bookingId: Id<"bookings">,
): Promise<Doc<"calendarOperations"> | null> {
  return await ctx.db
    .query("calendarOperations")
    .withIndex("by_bookingId", (q) => q.eq("bookingId", bookingId))
    .unique();
}

function bookingAcceptanceFingerprint(
  booking: Doc<"bookings">,
  page: Doc<"bookingPages">,
): string {
  const label = page.title?.trim() || "Meeting";
  return calendarRequestFingerprint({
    summary: `${label} with ${booking.requesterName}`,
    description: booking.note
      ? `Booked via qali.\n\n${booking.note}`
      : "Booked via qali.",
    startMs: booking.startMs,
    endMs: booking.endMs,
    allDay: false,
    timeZone: page.timeZone,
    attendees: [
      { email: booking.requesterEmail, displayName: booking.requesterName },
    ],
    notify: "all",
  });
}

async function mirrorSucceededAcceptance(
  ctx: MutationCtx,
  booking: Doc<"bookings">,
  operation: Doc<"calendarOperations">,
): Promise<void> {
  if (operation.status !== "succeeded" || !operation.providerEventId) return;
  await ctx.db.patch(booking._id, {
    status: "accepted",
    providerEventId: operation.providerEventId,
    connectionId: operation.connectionId,
    targetConnectionId: operation.connectionId,
    // The cutover nulls operation.localCalendarId; never copy undefined into
    // the booking's target pair.
    ...(operation.localCalendarId !== undefined
      ? { targetCalendarId: operation.localCalendarId }
      : {}),
    decidedAt: operation.updatedAt,
    acceptOperationId: operation.idempotencyKey,
  });
  await clearBookingNotifications(ctx, booking._id);
}

async function acceptanceTarget(
  ctx: MutationCtx,
  booking: Doc<"bookings">,
  page: Doc<"bookingPages">,
  operation: Doc<"calendarOperations"> | null,
): Promise<BookingTarget> {
  if (operation) {
    let calendar = operation.localCalendarId
      ? await ctx.db.get(operation.localCalendarId)
      : null;
    if (!calendar && operation.providerCalendarId) {
      // The cutover nulls operation.localCalendarId; the provider calendar id
      // survives, so re-resolve the row the connection now holds for it.
      const providerCalendarId = operation.providerCalendarId;
      calendar = await ctx.db
        .query("calendars")
        .withIndex("by_connection_and_providerCalendarId", (q) =>
          q
            .eq("connectionId", operation.connectionId)
            .eq("providerCalendarId", providerCalendarId),
        )
        .unique();
    }
    if (!calendar) throw new Error("Booking calendar target is unavailable");
    return await validateBookingTarget(
      ctx,
      booking.hostUserId,
      operation.connectionId,
      calendar._id,
      operation.providerCalendarId,
    );
  }
  if (booking.targetConnectionId && booking.targetCalendarId) {
    return await validateBookingTarget(
      ctx,
      booking.hostUserId,
      booking.targetConnectionId,
      booking.targetCalendarId,
    );
  }
  return await bookingPageTarget(ctx, page);
}

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

  const existing = await pageByUser(ctx, user._id);
  const target =
    existing?.targetConnectionId && existing.targetCalendarId
      ? await validateBookingTarget(
          ctx,
          user._id,
          existing.targetConnectionId,
          existing.targetCalendarId,
        )
      : await primaryGoogleBookingTarget(ctx, user._id);
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
    targetConnectionId: target.connection._id,
    targetCalendarId: target.calendar._id,
  };

  if (existing) {
    await ctx.db.patch(existing._id, value);
  } else {
    await ctx.db.insert("bookingPages", { userId: user._id, ...value });
  }
  return { slug };
}

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
  handler: (ctx, args) => upsertBookingPageHandler(ctx, args),
});

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

export const setOverride = mutation({
  args: {
    dateKey: v.string(),
    intervals: v.optional(
      v.array(v.object({ startMin: v.number(), endMin: v.number() })),
    ),
  },
  handler: (ctx, args) => setOverrideHandler(ctx, args),
});

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
    Date.now(),
  );
  const slot = slots.find((s) => s.startMs === args.startMs);
  if (!slot?.available) {
    throw new Error("That time is no longer available");
  }

  const token = crypto.randomUUID();
  const target = await bookingPageTarget(ctx, page);
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
    connectionId: target.connection._id,
    targetConnectionId: target.connection._id,
    targetCalendarId: target.calendar._id,
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
  await ctx.scheduler.runAt(
    endMs,
    internal.domains.booking.mutations.expireBooking,
    { bookingId },
  );
  return { token };
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
  handler: (ctx, args) => requestBookingHandler(ctx, args),
});

/** Expire one request at its scheduled end. A decision that won the race first
 * is left untouched. */
export async function expireBookingHandler(
  ctx: MutationCtx,
  args: { bookingId: Id<"bookings"> },
): Promise<null> {
  const booking = await ctx.db.get(args.bookingId);
  if (!booking || booking.status !== "pending" || booking.endMs > Date.now()) {
    return null;
  }
  const now = Date.now();
  const operation = await operationForBooking(ctx, booking._id);
  if (operation?.status === "succeeded") {
    await mirrorSucceededAcceptance(ctx, booking, operation);
    return null;
  }
  if (
    operation?.status === "ambiguous" ||
    (operation?.status === "pending" && operation.mayHaveSucceeded === true)
  ) {
    return null;
  }
  const leaseExpiresAt =
    operation?.status === "pending" ? operation.leaseExpiresAt : undefined;
  if (leaseExpiresAt && leaseExpiresAt > now) {
    await ctx.scheduler.runAt(
      leaseExpiresAt,
      internal.domains.booking.mutations.expireBooking,
      { bookingId: booking._id },
    );
    return null;
  }
  await ctx.db.patch(args.bookingId, { status: "expired" });
  await clearBookingNotifications(ctx, args.bookingId);
  return null;
}

export const expireBooking = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: (ctx, args) => expireBookingHandler(ctx, args),
});

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
    const operation = await operationForBooking(ctx, booking._id);
    if (operation?.status === "succeeded") {
      await mirrorSucceededAcceptance(ctx, booking, operation);
      continue;
    }
    if (
      operation?.status === "ambiguous" ||
      (operation?.status === "pending" && operation.mayHaveSucceeded === true)
    ) {
      continue;
    }
    const leaseExpiresAt =
      operation?.status === "pending" ? operation.leaseExpiresAt : undefined;
    if (leaseExpiresAt && leaseExpiresAt > Date.now()) {
      continue;
    }
    await ctx.db.patch(booking._id, { status: "expired" });
    await clearBookingNotifications(ctx, booking._id);
  }
  if (rows.length === EXPIRATION_BATCH_SIZE) {
    await ctx.scheduler.runAfter(
      0,
      internal.domains.booking.mutations.expirePastBookings,
      {},
    );
  }
  return null;
}

export const expirePastBookings = internalMutation({
  args: {},
  handler: (ctx) => expirePastBookingsHandler(ctx),
});

/** Settle the operation ledger and stamp the booking's accepted mirror. The
 * ledger row is authoritative: without one held by this attempt, the settle
 * refuses. */
export async function markAcceptedHandler(
  ctx: MutationCtx,
  args: {
    bookingId: Id<"bookings">;
    hostUserId: string;
    providerEventId: string;
    providerCalendarId: string;
    attemptId: string;
  },
): Promise<boolean> {
  const booking = await ctx.db.get(args.bookingId);
  if (
    !booking ||
    booking.hostUserId !== args.hostUserId ||
    booking.status !== "pending"
  ) {
    return false;
  }
  const page = await pageByUser(ctx, args.hostUserId);
  if (!page) return false;
  const operation = await operationForBooking(ctx, booking._id);
  if (
    !operation ||
    operation.status !== "pending" ||
    operation.attemptId !== args.attemptId ||
    operation.providerCalendarId !== args.providerCalendarId
  ) {
    return false;
  }
  const target = await acceptanceTarget(ctx, booking, page, operation);
  const now = Date.now();
  await ctx.db.patch(operation._id, {
    status: "succeeded",
    attemptId: undefined,
    leaseExpiresAt: undefined,
    mayHaveSucceeded: undefined,
    localCalendarId: target.calendar._id,
    providerCalendarId: target.providerCalendarId,
    providerEventId: args.providerEventId,
    lastError: undefined,
    updatedAt: now,
  });
  await ctx.db.patch(args.bookingId, {
    status: "accepted",
    connectionId: target.connection._id,
    providerEventId: args.providerEventId,
    targetConnectionId: target.connection._id,
    targetCalendarId: target.calendar._id,
    decidedAt: now,
    acceptOperationId: operation.idempotencyKey,
  });
  await clearBookingNotifications(ctx, args.bookingId);
  return true;
}

export const markAccepted = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hostUserId: v.string(),
    providerEventId: v.string(),
    providerCalendarId: v.string(),
    attemptId: v.string(),
  },
  handler: (ctx, args) => markAcceptedHandler(ctx, args),
});

/** Claim the operation ledger and recheck the slot in the same transaction. */
export async function claimBookingAcceptanceHandler(
  ctx: MutationCtx,
  args: {
    bookingId: Id<"bookings">;
    hostUserId: string;
    attemptId: string;
    reconciliation?: boolean;
    expectedGeneration?: number;
  },
) {
  const now = Date.now();
  const booking = await ctx.db.get(args.bookingId);
  if (
    !booking ||
    booking.hostUserId !== args.hostUserId ||
    booking.status !== "pending"
  ) {
    return null;
  }
  const operation = await operationForBooking(ctx, booking._id);
  if (operation?.status === "succeeded") {
    await mirrorSucceededAcceptance(ctx, booking, operation);
    return null;
  }
  if (
    args.expectedGeneration !== undefined &&
    operation?.reconcileGeneration !== args.expectedGeneration
  ) {
    return null;
  }
  if (
    args.reconciliation &&
    (operation?.reconcileAttemptCount ?? 0) >= ACCEPT_RECONCILE_MAX_ATTEMPTS
  ) {
    return null;
  }
  const page = await pageByUser(ctx, args.hostUserId);
  if (!page) return null;
  const requestFingerprint = bookingAcceptanceFingerprint(booking, page);
  if (
    operation?.requestFingerprint !== undefined &&
    operation.requestFingerprint !== requestFingerprint
  ) {
    throw new Error("Calendar operation key was already used for another write");
  }
  const liveLedgerLease =
    operation?.status === "pending" &&
    operation.attemptId !== undefined &&
    (operation.leaseExpiresAt ?? 0) > now;
  if (liveLedgerLease) return null;

  const target = await acceptanceTarget(ctx, booking, page, operation);
  const operationId =
    operation?.idempotencyKey ??
    booking.acceptOperationId ??
    crypto.randomUUID();
  const reconcileOnly =
    operation !== null &&
    (operation.status === "ambiguous" || operation.mayHaveSucceeded === true);
  if (booking.endMs <= now && !reconcileOnly) return null;
  const busy = await collectBusy(
    ctx,
    page,
    booking.startMs,
    booking.endMs,
    booking._id,
    operation?.providerEventId,
  );
  if (
    !reconcileOnly &&
    busy.some(
      (span) => span.startMs < booking.endMs && span.endMs > booking.startMs,
    )
  ) {
    throw new Error("That time is no longer free on your calendar");
  }
  const reconcileGeneration = (operation?.reconcileGeneration ?? 0) + 1;
  const reconcileAttemptCount =
    (operation?.reconcileAttemptCount ?? 0) + (args.reconciliation ? 1 : 0);
  const leaseExpiresAt = now + ACCEPT_LEASE_MS;
  const operationValue = {
    status: "pending" as const,
    bookingId: booking._id,
    attemptId: args.attemptId,
    leaseExpiresAt,
    // Conservative until a known provider failure clears it. If this action
    // disappears, rejection cannot contradict a possibly sent invitation.
    mayHaveSucceeded: true,
    localCalendarId: target.calendar._id,
    providerCalendarId: target.providerCalendarId,
    requestFingerprint: operation?.requestFingerprint ?? requestFingerprint,
    providerEventId: operation?.providerEventId ?? booking.providerEventId,
    reconcileAttemptCount,
    reconcileGeneration,
    lastError: undefined,
    updatedAt: now,
  };
  if (operation) {
    await ctx.db.patch(operation._id, operationValue);
  } else {
    await ctx.db.insert("calendarOperations", {
      connectionId: target.connection._id,
      userId: args.hostUserId,
      idempotencyKey: operationId,
      kind: "create",
      createdAt: now,
      ...operationValue,
    });
  }
  await ctx.db.patch(booking._id, {
    acceptOperationId: operationId,
    connectionId: target.connection._id,
    targetConnectionId: target.connection._id,
    targetCalendarId: target.calendar._id,
  });
  await ctx.scheduler.runAt(
    leaseExpiresAt,
    internal.domains.booking.service.reconcileBookingAcceptance,
    { bookingId: booking._id, expectedGeneration: reconcileGeneration },
  );
  return {
    booking,
    page,
    operationId,
    connectionId: target.connection._id,
    localCalendarId: target.calendar._id,
    providerCalendarId: target.providerCalendarId,
    reconcileOnly,
    reconcileGeneration,
    reconcileAttemptCount,
  };
}

export const claimBookingAcceptance = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hostUserId: v.string(),
    attemptId: v.string(),
    reconciliation: v.optional(v.boolean()),
    expectedGeneration: v.optional(v.number()),
  },
  handler: (ctx, args) => claimBookingAcceptanceHandler(ctx, args),
});

/** Scheduled claims derive authority from the booking rather than a user
 * session. The expected generation makes duplicate/lost-action watchdogs no-op. */
export async function claimScheduledBookingAcceptanceHandler(
  ctx: MutationCtx,
  args: {
    bookingId: Id<"bookings">;
    attemptId: string;
    expectedGeneration: number;
  },
) {
  const booking = await ctx.db.get(args.bookingId);
  if (!booking || booking.status !== "pending") return null;
  let claimed;
  try {
    claimed = await claimBookingAcceptanceHandler(ctx, {
      bookingId: booking._id,
      hostUserId: booking.hostUserId,
      attemptId: args.attemptId,
      reconciliation: true,
      expectedGeneration: args.expectedGeneration,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Booking calendar target is unavailable"
    ) return null;
    throw error;
  }
  return claimed ? { ...claimed, hostUserId: booking.hostUserId } : null;
}

export const claimScheduledBookingAcceptance = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    attemptId: v.string(),
    expectedGeneration: v.number(),
  },
  handler: (ctx, args) => claimScheduledBookingAcceptanceHandler(ctx, args),
});

export async function releaseBookingAcceptanceHandler(
  ctx: MutationCtx,
  args: {
    bookingId: Id<"bookings">;
    hostUserId: string;
    attemptId: string;
    mayHaveSucceeded: boolean;
    error?: string;
  },
): Promise<null> {
  const booking = await ctx.db.get(args.bookingId);
  if (
    !booking ||
    booking.hostUserId !== args.hostUserId ||
    booking.status !== "pending"
  ) {
    return null;
  }
  const operation = await operationForBooking(ctx, booking._id);
  if (
    !operation ||
    operation.status !== "pending" ||
    operation.attemptId !== args.attemptId
  ) {
    return null;
  }
  const now = Date.now();
  await ctx.db.patch(operation._id, {
    status: args.mayHaveSucceeded ? "ambiguous" : "failed",
    attemptId: undefined,
    leaseExpiresAt: undefined,
    mayHaveSucceeded: args.mayHaveSucceeded,
    lastError: args.error,
    updatedAt: now,
  });
  if (
    args.mayHaveSucceeded &&
    (operation.reconcileAttemptCount ?? 0) < ACCEPT_RECONCILE_MAX_ATTEMPTS
  ) {
    const attempt = operation.reconcileAttemptCount ?? 0;
    const delay = ACCEPT_RECONCILE_BASE_DELAY_MS * 2 ** Math.min(attempt, 4);
    await ctx.scheduler.runAfter(
      delay,
      internal.domains.booking.service.reconcileBookingAcceptance,
      {
        bookingId: booking._id,
        expectedGeneration: operation.reconcileGeneration ?? 0,
      },
    );
  } else if (!args.mayHaveSucceeded && booking.endMs <= now) {
    await ctx.scheduler.runAfter(
      0,
      internal.domains.booking.mutations.expireBooking,
      { bookingId: booking._id },
    );
  }
  return null;
}

export const releaseBookingAcceptance = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hostUserId: v.string(),
    attemptId: v.string(),
    mayHaveSucceeded: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: (ctx, args) => releaseBookingAcceptanceHandler(ctx, args),
});

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
  return await rejectBookingForHostHandler(ctx, {
    bookingId: args.bookingId,
    hostUserId: user._id,
  });
}

export const rejectBooking = mutation({
  args: { bookingId: v.id("bookings") },
  handler: (ctx, args) => rejectBookingHandler(ctx, args),
});

/** Internal core kept separately so the authorization wrapper stays public-only. */
export async function rejectBookingForHostHandler(
  ctx: MutationCtx,
  args: { bookingId: Id<"bookings">; hostUserId: string },
): Promise<null> {
  const booking = await ctx.db.get(args.bookingId);
  if (!booking || booking.hostUserId !== args.hostUserId) {
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
  const operation = await operationForBooking(ctx, booking._id);
  if (operation?.status === "succeeded") {
    throw new Error("This request has already been answered");
  }
  const activeLease =
    operation?.status === "pending" &&
    operation.attemptId !== undefined &&
    (operation.leaseExpiresAt ?? 0) > Date.now();
  if (activeLease) {
    throw new Error("This request is currently being accepted");
  }
  const mayHaveSucceeded =
    operation?.status === "ambiguous" ||
    (operation?.status === "pending" && operation.mayHaveSucceeded === true);
  if (mayHaveSucceeded) {
    throw new Error(
      "A previous acceptance may have reached the calendar provider. Retry acceptance to reconcile it before rejecting.",
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

export const rejectBookingForHost = internalMutation({
  args: { bookingId: v.id("bookings"), hostUserId: v.string() },
  handler: (ctx, args) => rejectBookingForHostHandler(ctx, args),
});
