/**
 * Booking acceptance — the one booking operation that talks to a calendar
 * provider, so it is an action, not a mutation. Canonical registration for
 * `acceptBooking` / `reconcileBookingAcceptance`.
 *
 * The calendar write goes through the provider adapter (via the registry), so
 * this path is provider-neutral: `createEventReconciling` creates the event and,
 * on an ambiguous/conflict failure, reconciles by the operation's idempotency
 * key instead of risking a duplicate. The claim/mark/release lease lives in the
 * operation ledger. `notify:"all"` makes the provider send its invitation email,
 * which is the requester's confirmation — the app sends none.
 */

import { v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  action,
  type ActionCtx,
  internalAction,
} from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  isDefinitiveProviderFailure,
  ProviderError,
} from "../../integrations/calendar/errors";
import { getCalendarAdapter } from "../../integrations/calendar/registry";
import { createEventReconciling } from "../../integrations/calendar/service";
import type { CalendarProviderAdapter } from "../../integrations/calendar/types";
import { withHostAttendee } from "../calendar/hostAttendee";
import { bookingEventCreate, type claimBookingAcceptanceHandler } from "./mutations";

type AcceptanceClaim = NonNullable<
  Awaited<ReturnType<typeof claimBookingAcceptanceHandler>>
>;

async function executeAcceptanceClaim(
  ctx: ActionCtx,
  claimed: AcceptanceClaim,
  hostUserId: string,
  attemptId: string,
  adapter: CalendarProviderAdapter,
  autonomous: boolean,
): Promise<void> {
  const {
    booking,
    page,
    operationId,
    connectionId,
    localCalendarId,
    providerCalendarId,
    accountEmail,
    reconcileOnly,
  } = claimed;
  let event;
  try {
    if (reconcileOnly) {
      event =
        (await adapter.reconcileAmbiguousCreate({
          calendarId: providerCalendarId,
          idempotencyKey: operationId,
        })) ?? undefined;
    }
    if (!event && reconcileOnly && !autonomous) {
      throw new ProviderError(
        "not-found",
        "The previous calendar create did not land; retry to create it again",
      );
    }
    if (!event && reconcileOnly && autonomous && booking.endMs <= Date.now()) {
      throw new ProviderError(
        "not-found",
        "The previous calendar create did not land before the booking expired",
      );
    }
    // A scheduled reconciliation that proves the first create did not land may
    // safely retry with the same provider idempotency key. This cannot send a
    // duplicate invitation even if a delayed provider write appears later.
    // The host joins the guest list as an accepted organizer so the event
    // shows them alongside the requester (see withHostAttendee).
    const base = bookingEventCreate(booking, page);
    event ??= await createEventReconciling(adapter, {
      calendarId: providerCalendarId,
      event: {
        ...base,
        attendees: withHostAttendee(base.attendees, {
          email: accountEmail,
          displayName: page.displayName,
        }),
      },
      idempotencyKey: operationId,
      notify: "all",
    });

    const marked = await ctx.runMutation(
      internal.domains.booking.mutations.markAccepted,
      {
        bookingId: booking._id,
        hostUserId,
        providerEventId: event.id,
        providerCalendarId: event.calendarId,
        attemptId,
      },
    );
    if (!marked) throw new Error("Booking acceptance claim was lost");
  } catch (error) {
    await ctx.runMutation(
      internal.domains.booking.mutations.releaseBookingAcceptance,
      {
        bookingId: booking._id,
        hostUserId,
        attemptId,
        mayHaveSucceeded:
          event !== undefined || !isDefinitiveProviderFailure(error),
        error: error instanceof Error ? error.message : String(error),
      },
    );
    throw error;
  }

  try {
    await ctx.runMutation(
      internal.domains.calendar.mutations.mirrorProviderEvent,
      {
        userId: hostUserId,
        connectionId,
        localCalendarId,
        event: {
          ...event,
          attendees: event.attendees?.map((attendee) => ({ ...attendee })),
          recurrence: event.recurrence ? [...event.recurrence] : undefined,
          organizer: event.organizer ? { ...event.organizer } : undefined,
          creator: event.creator ? { ...event.creator } : undefined,
          conference: event.conference ? { ...event.conference } : undefined,
        },
      },
    );
  } catch (error) {
    console.error("[booking] provider accepted event; mirror pending", error);
  }
}

/** The acceptance flow once the host is known. `hostUserId` must be an already
 * verified identity — the session user, or the assistant thread's owner — since
 * the claim mutation treats it as the authorization. */
export async function acceptBookingForHost(
  ctx: ActionCtx,
  args: { bookingId: Id<"bookings">; hostUserId: string },
): Promise<null> {
  const attemptId = crypto.randomUUID();
  const claimed = await ctx.runMutation(
    internal.domains.booking.mutations.claimBookingAcceptance,
    {
      bookingId: args.bookingId,
      hostUserId: args.hostUserId,
      attemptId,
    },
  );
  if (!claimed) {
    const context = await ctx.runQuery(
      internal.domains.booking.queries.getBookingContext,
      {
        bookingId: args.bookingId,
        hostUserId: args.hostUserId,
      },
    );
    if (
      context?.booking.status === "accepted" ||
      context?.acceptanceOperation?.status === "succeeded"
    ) {
      return null;
    }
    throw new Error("This request is unavailable or already being answered");
  }
  let adapter;
  try {
    adapter = await getCalendarAdapter(ctx, args.hostUserId, claimed.connectionId);
  } catch (error) {
    await ctx.runMutation(
      internal.domains.booking.mutations.releaseBookingAcceptance,
      {
        bookingId: args.bookingId,
        hostUserId: args.hostUserId,
        attemptId,
        mayHaveSucceeded: claimed.reconcileOnly,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    throw error;
  }

  await executeAcceptanceClaim(
    ctx,
    claimed,
    args.hostUserId,
    attemptId,
    adapter,
    false,
  );

  return null;
}

export async function acceptBookingHandler(
  ctx: ActionCtx,
  args: { bookingId: Id<"bookings"> },
): Promise<null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }
  return await acceptBookingForHost(ctx, {
    bookingId: args.bookingId,
    hostUserId: user._id,
  });
}

export const acceptBooking = action({
  args: { bookingId: v.id("bookings") },
  handler: (ctx, args) => acceptBookingHandler(ctx, args),
});

export async function reconcileBookingAcceptanceWithAdapter(
  ctx: ActionCtx,
  args: { bookingId: Id<"bookings">; expectedGeneration: number },
  adapter: CalendarProviderAdapter,
): Promise<void> {
  const attemptId = crypto.randomUUID();
  const claimed = await ctx.runMutation(
    internal.domains.booking.mutations.claimScheduledBookingAcceptance,
    { ...args, attemptId },
  );
  if (!claimed) return;
  try {
    await executeAcceptanceClaim(
      ctx,
      claimed,
      claimed.hostUserId,
      attemptId,
      adapter,
      true,
    );
  } catch (error) {
    console.error(
      `[booking] scheduled acceptance reconciliation failed for ${args.bookingId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function reconcileBookingAcceptanceHandler(
  ctx: ActionCtx,
  args: { bookingId: Id<"bookings">; expectedGeneration: number },
): Promise<null> {
  const attemptId = crypto.randomUUID();
  const claimed = await ctx.runMutation(
    internal.domains.booking.mutations.claimScheduledBookingAcceptance,
    { ...args, attemptId },
  );
  if (!claimed) return null;
  let adapter: CalendarProviderAdapter;
  try {
    adapter = await getCalendarAdapter(ctx, claimed.hostUserId, claimed.connectionId);
  } catch (error) {
    await ctx.runMutation(
      internal.domains.booking.mutations.releaseBookingAcceptance,
      {
        bookingId: args.bookingId,
        hostUserId: claimed.hostUserId,
        attemptId,
        mayHaveSucceeded: claimed.reconcileOnly,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
  try {
    await executeAcceptanceClaim(
      ctx,
      claimed,
      claimed.hostUserId,
      attemptId,
      adapter,
      true,
    );
  } catch (error) {
    console.error(
      `[booking] scheduled acceptance reconciliation failed for ${args.bookingId}:`,
      error instanceof Error ? error.message : error,
    );
  }
  return null;
}

export const reconcileBookingAcceptance = internalAction({
  args: {
    bookingId: v.id("bookings"),
    expectedGeneration: v.number(),
  },
  handler: (ctx, args) => reconcileBookingAcceptanceHandler(ctx, args),
});
