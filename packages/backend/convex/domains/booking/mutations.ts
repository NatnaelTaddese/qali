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
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
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

async function localCalendarForProviderId(
  ctx: MutationCtx,
  userId: string,
  providerCalendarId: string,
) {
  return await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (q) =>
      q.eq("userId", userId).eq("googleCalendarId", providerCalendarId),
    )
    .unique();
}

async function primaryLocalCalendar(ctx: MutationCtx, userId: string) {
  return (
    await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("primary"), true))
      .take(1)
  )[0];
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
  const providerCalendarId =
    calendar?.providerCalendarId ?? calendar?.googleCalendarId;
  if (
    !connection ||
    connection.userId !== userId ||
    connection.status !== "active" ||
    !calendar ||
    !providerCalendarId ||
    calendar.userId !== userId ||
    !calendarIsWritable(calendar) ||
    (calendar.connectionId !== undefined &&
      calendar.connectionId !== connection._id) ||
    (expectedProviderCalendarId !== undefined &&
      providerCalendarId !== expectedProviderCalendarId)
  ) {
    throw new Error("Booking calendar target is unavailable");
  }
  const resolvedProviderCalendarId = providerCalendarId;
  if (
    calendar.connectionId === undefined ||
    calendar.providerCalendarId === undefined
  ) {
    await ctx.db.patch(calendar._id, {
      connectionId: connection._id,
      providerCalendarId: resolvedProviderCalendarId,
    });
  }
  return {
    connection,
    calendar,
    providerCalendarId: resolvedProviderCalendarId,
  };
}

async function primaryGoogleBookingTarget(
  ctx: MutationCtx,
  userId: string,
): Promise<BookingTarget> {
  const connectionId = await ensureGoogleConnection(ctx, userId);
  const calendar = await primaryLocalCalendar(ctx, userId);
  if (!calendar) throw new Error("No writable primary calendar is available");
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

async function mirrorSucceededAcceptance(
  ctx: MutationCtx,
  booking: Doc<"bookings">,
  operation: Doc<"calendarOperations">,
): Promise<void> {
  if (operation.status !== "succeeded" || !operation.providerEventId) return;
  await ctx.db.patch(booking._id, {
    status: "accepted",
    googleEventId: operation.providerEventId,
    providerEventId: operation.providerEventId,
    calendarId: operation.providerCalendarId,
    connectionId: operation.connectionId,
    targetConnectionId: operation.connectionId,
    targetCalendarId: operation.localCalendarId,
    decidedAt: operation.updatedAt,
    acceptOperationId: operation.idempotencyKey,
    acceptAttemptId: undefined,
    acceptLeaseExpiresAt: undefined,
    acceptMayHaveSucceeded: undefined,
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
      calendar = await ctx.db
        .query("calendars")
        .withIndex("by_connection_and_providerCalendarId", (q) =>
          q
            .eq("connectionId", operation.connectionId)
            .eq("providerCalendarId", operation.providerCalendarId),
        )
        .unique();
    }
    if (!calendar && operation.providerCalendarId) {
      calendar = await localCalendarForProviderId(
        ctx,
        booking.hostUserId,
        operation.providerCalendarId,
      );
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
      booking.calendarId,
    );
  }
  if (booking.calendarId) {
    const calendar = await localCalendarForProviderId(
      ctx,
      booking.hostUserId,
      booking.calendarId,
    );
    const connectionId = booking.targetConnectionId ?? booking.connectionId;
    if (calendar && connectionId) {
      return await validateBookingTarget(
        ctx,
        booking.hostUserId,
        connectionId,
        calendar._id,
        booking.calendarId,
      );
    }
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

  const target = await primaryGoogleBookingTarget(ctx, user._id);
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
  if (!booking || booking.status !== "pending" || booking.endMs > Date.now()) {
    return null;
  }
  const now = Date.now();
  const operation = await operationForBooking(ctx, booking._id);
  if (operation?.status === "succeeded") {
    await mirrorSucceededAcceptance(ctx, booking, operation);
    return null;
  }
  const leaseExpiresAt = operation
    ? operation.status === "pending"
      ? operation.leaseExpiresAt
      : undefined
    : booking.acceptAttemptId
      ? booking.acceptLeaseExpiresAt
      : undefined;
  if (leaseExpiresAt && leaseExpiresAt > now) {
    await ctx.scheduler.runAt(leaseExpiresAt, internal.booking.expireBooking, {
      bookingId: booking._id,
    });
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
    const operation = await operationForBooking(ctx, booking._id);
    if (operation?.status === "succeeded") {
      await mirrorSucceededAcceptance(ctx, booking, operation);
      continue;
    }
    const leaseExpiresAt = operation
      ? operation.status === "pending"
        ? operation.leaseExpiresAt
        : undefined
      : booking.acceptAttemptId
        ? booking.acceptLeaseExpiresAt
        : undefined;
    if (leaseExpiresAt && leaseExpiresAt > Date.now()) {
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

/** Settle the operation ledger, then dual-write the legacy booking fields. */
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
  let operation = await operationForBooking(ctx, booking._id);
  if (operation) {
    if (
      operation.status !== "pending" ||
      operation.attemptId !== args.attemptId ||
      operation.providerCalendarId !== args.providerCalendarId
    ) {
      return false;
    }
  } else {
    if (
      booking.acceptAttemptId !== args.attemptId ||
      !booking.acceptOperationId
    ) {
      return false;
    }
    const target = await acceptanceTarget(ctx, booking, page, null);
    if (target.providerCalendarId !== args.providerCalendarId) return false;
    const now = Date.now();
    const operationId = await ctx.db.insert("calendarOperations", {
      connectionId: target.connection._id,
      userId: args.hostUserId,
      idempotencyKey: booking.acceptOperationId,
      kind: "create",
      status: "pending",
      bookingId: booking._id,
      attemptId: args.attemptId,
      leaseExpiresAt: booking.acceptLeaseExpiresAt,
      mayHaveSucceeded: booking.acceptMayHaveSucceeded,
      localCalendarId: target.calendar._id,
      providerCalendarId: target.providerCalendarId,
      createdAt: now,
      updatedAt: now,
    });
    operation = (await ctx.db.get(operationId))!;
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
    googleEventId: args.providerEventId,
    calendarId: target.providerCalendarId,
    connectionId: target.connection._id,
    providerEventId: args.providerEventId,
    targetConnectionId: target.connection._id,
    targetCalendarId: target.calendar._id,
    decidedAt: now,
    acceptOperationId: operation.idempotencyKey,
    acceptAttemptId: undefined,
    acceptLeaseExpiresAt: undefined,
    acceptMayHaveSucceeded: undefined,
  });
  await clearBookingNotifications(ctx, args.bookingId);
  return true;
}

/** Claim the operation ledger and recheck the slot in the same transaction. */
export async function claimBookingAcceptanceHandler(
  ctx: MutationCtx,
  args: {
    bookingId: Id<"bookings">;
    hostUserId: string;
    attemptId: string;
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
  if (booking.endMs <= now) return null;
  const page = await pageByUser(ctx, args.hostUserId);
  if (!page) return null;
  const liveLedgerLease =
    operation?.status === "pending" &&
    operation.attemptId !== undefined &&
    (operation.leaseExpiresAt ?? 0) > now;
  const liveLegacyLease =
    !operation &&
    booking.acceptAttemptId !== undefined &&
    (booking.acceptLeaseExpiresAt ?? 0) > now;
  if (liveLedgerLease || liveLegacyLease) return null;

  const target = await acceptanceTarget(ctx, booking, page, operation);
  const operationId =
    operation?.idempotencyKey ??
    booking.acceptOperationId ??
    crypto.randomUUID();
  const reconcileOnly = operation
    ? operation.status === "ambiguous" || operation.mayHaveSucceeded === true
    : booking.acceptMayHaveSucceeded === true;
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
  const operationValue = {
    status: "pending" as const,
    bookingId: booking._id,
    attemptId: args.attemptId,
    leaseExpiresAt: now + ACCEPT_LEASE_MS,
    mayHaveSucceeded: true,
    localCalendarId: target.calendar._id,
    providerCalendarId: target.providerCalendarId,
    providerEventId: operation?.providerEventId ?? booking.providerEventId,
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
    acceptAttemptId: args.attemptId,
    acceptLeaseExpiresAt: now + ACCEPT_LEASE_MS,
    // Conservative until a known Google failure clears it. If this action
    // disappears, rejection cannot contradict a possibly sent invitation.
    acceptMayHaveSucceeded: true,
    calendarId: target.providerCalendarId,
    connectionId: target.connection._id,
    targetConnectionId: target.connection._id,
    targetCalendarId: target.calendar._id,
  });
  return {
    booking,
    page,
    operationId,
    connectionId: target.connection._id,
    localCalendarId: target.calendar._id,
    providerCalendarId: target.providerCalendarId,
    reconcileOnly,
  };
}

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
  let operation = await operationForBooking(ctx, booking._id);
  if (operation) {
    if (
      operation.status !== "pending" ||
      operation.attemptId !== args.attemptId
    ) {
      return null;
    }
  } else {
    if (
      booking.acceptAttemptId !== args.attemptId ||
      !booking.acceptOperationId
    ) {
      return null;
    }
    const page = await pageByUser(ctx, args.hostUserId);
    if (!page) return null;
    const target = await acceptanceTarget(ctx, booking, page, null);
    const now = Date.now();
    const operationId = await ctx.db.insert("calendarOperations", {
      connectionId: target.connection._id,
      userId: args.hostUserId,
      idempotencyKey: booking.acceptOperationId,
      kind: "create",
      status: "pending",
      bookingId: booking._id,
      attemptId: args.attemptId,
      leaseExpiresAt: booking.acceptLeaseExpiresAt,
      mayHaveSucceeded: booking.acceptMayHaveSucceeded,
      localCalendarId: target.calendar._id,
      providerCalendarId: target.providerCalendarId,
      providerEventId: booking.providerEventId,
      createdAt: now,
      updatedAt: now,
    });
    operation = (await ctx.db.get(operationId))!;
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
  await ctx.db.patch(booking._id, {
    acceptAttemptId: undefined,
    acceptLeaseExpiresAt: undefined,
    acceptMayHaveSucceeded: args.mayHaveSucceeded,
  });
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
  return await rejectBookingForHostHandler(ctx, {
    bookingId: args.bookingId,
    hostUserId: user._id,
  });
}

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
  const activeLease = operation
    ? operation.status === "pending" &&
      operation.attemptId !== undefined &&
      (operation.leaseExpiresAt ?? 0) > Date.now()
    : booking.acceptAttemptId !== undefined &&
      (booking.acceptLeaseExpiresAt ?? 0) > Date.now();
  if (activeLease) {
    throw new Error("This request is currently being accepted");
  }
  const mayHaveSucceeded = operation
    ? operation.status === "ambiguous" ||
      (operation.status === "pending" && operation.mayHaveSucceeded === true)
    : booking.acceptMayHaveSucceeded === true;
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
