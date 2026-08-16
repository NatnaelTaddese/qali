/**
 * Booking acceptance — the one booking operation that talks to a calendar
 * provider, so it is an action, not a mutation. The root `booking.ts` wraps this
 * handler in a Convex `action` at `api.booking.acceptBooking`.
 *
 * The calendar write goes through the provider adapter (via the registry), so
 * this path is provider-neutral: `createEventReconciling` creates the event and,
 * on an ambiguous/conflict failure, reconciles by the operation's idempotency
 * key instead of risking a duplicate. The claim/mark/release lease lives in the
 * operation ledger. `notify:"all"` makes the provider send its invitation email,
 * which is the requester's confirmation — the app sends none.
 */

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  isDefinitiveProviderFailure,
  ProviderError,
} from "../../integrations/calendar/errors";
import { getCalendarAdapter } from "../../integrations/calendar/registry";
import { createEventReconciling } from "../../integrations/calendar/service";
import type { CalendarProviderAdapter } from "../../integrations/calendar/types";
import type { claimBookingAcceptanceHandler } from "./mutations";

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
    reconcileOnly,
  } = claimed;
  const label = page.title?.trim() || "Meeting";
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
    event ??= await createEventReconciling(adapter, {
      calendarId: providerCalendarId,
      event: {
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
      },
      idempotencyKey: operationId,
      notify: "all",
    });

    const marked = await ctx.runMutation(internal.booking.markAccepted, {
      bookingId: booking._id,
      hostUserId,
      providerEventId: event.id,
      providerCalendarId: event.calendarId,
      attemptId,
    });
    if (!marked) throw new Error("Booking acceptance claim was lost");
  } catch (error) {
    await ctx.runMutation(internal.booking.releaseBookingAcceptance, {
      bookingId: booking._id,
      hostUserId,
      attemptId,
      mayHaveSucceeded:
        event !== undefined || !isDefinitiveProviderFailure(error),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  try {
    await ctx.runMutation(internal.calendar.mirrorProviderEvent, {
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
    });
  } catch (error) {
    console.error("[booking] provider accepted event; mirror pending", error);
  }
}

export async function acceptBookingHandler(
  ctx: ActionCtx,
  args: { bookingId: Id<"bookings"> },
): Promise<null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }

  const attemptId = crypto.randomUUID();
  const claimed = await ctx.runMutation(
    internal.booking.claimBookingAcceptance,
    {
      bookingId: args.bookingId,
      hostUserId: user._id,
      attemptId,
    },
  );
  if (!claimed) {
    const context = await ctx.runQuery(internal.booking.getBookingContext, {
      bookingId: args.bookingId,
      hostUserId: user._id,
    });
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
    adapter = await getCalendarAdapter(ctx, claimed.connectionId);
  } catch (error) {
    await ctx.runMutation(internal.booking.releaseBookingAcceptance, {
      bookingId: args.bookingId,
      hostUserId: user._id,
      attemptId,
      mayHaveSucceeded: claimed.reconcileOnly,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  await executeAcceptanceClaim(ctx, claimed, user._id, attemptId, adapter, false);

  return null;
}

export async function reconcileBookingAcceptanceWithAdapter(
  ctx: ActionCtx,
  args: { bookingId: Id<"bookings">; expectedGeneration: number },
  adapter: CalendarProviderAdapter,
): Promise<void> {
  const attemptId = crypto.randomUUID();
  const claimed = await ctx.runMutation(
    internal.booking.claimScheduledBookingAcceptance,
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
    internal.booking.claimScheduledBookingAcceptance,
    { ...args, attemptId },
  );
  if (!claimed) return null;
  let adapter: CalendarProviderAdapter;
  try {
    adapter = await getCalendarAdapter(ctx, claimed.connectionId);
  } catch (error) {
    await ctx.runMutation(internal.booking.releaseBookingAcceptance, {
      bookingId: args.bookingId,
      hostUserId: claimed.hostUserId,
      attemptId,
      mayHaveSucceeded: claimed.reconcileOnly,
      error: error instanceof Error ? error.message : String(error),
    });
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
