/**
 * Booking acceptance — the one booking operation that talks to a calendar
 * provider, so it is an action, not a mutation. The root `booking.ts` wraps this
 * handler in a Convex `action` at `api.booking.acceptBooking`.
 *
 * The calendar write goes through the provider adapter (via the registry), so
 * this path is provider-neutral: `createEventReconciling` creates the event and,
 * on an ambiguous/conflict failure, reconciles by the operation's idempotency
 * key instead of risking a duplicate. The claim/mark/release lease around it is
 * unchanged. `notify:"all"` makes the provider send its own invitation email,
 * which is the requester's confirmation — the app sends none.
 */

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import { ProviderError } from "../../integrations/calendar/errors";
import { getCalendarAdapter } from "../../integrations/calendar/registry";
import { createEventReconciling } from "../../integrations/calendar/service";
import { providerEventToMapped } from "../../integrations/google/mappers";

export async function acceptBookingHandler(
  ctx: ActionCtx,
  args: { bookingId: Id<"bookings"> },
): Promise<null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }

  // Resolve the adapter (the credential broker resolves the token inside it)
  // before claiming, so a missing/invalid grant fails fast without taking a lease.
  const adapter = await getCalendarAdapter(ctx, user._id);

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
  let event;
  try {
    // The operationId is the idempotency key: a retry that already created the
    // event reconciles instead of double-booking (adapter maps it to Google's
    // client-assigned event id + 409-as-success).
    const providerEvent = await createEventReconciling(adapter, {
      calendarId: claimedCalendarId,
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
    event = providerEventToMapped(providerEvent);

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
      // An ambiguous provider failure (a lost response) is the "may have landed"
      // case — the neutral successor to the old GoogleNetworkError branch.
      mayHaveSucceeded:
        event !== undefined ||
        (error instanceof ProviderError && error.kind === "ambiguous"),
    });
    if (event) {
      throw new Error(
        `Google accepted the booking, but local confirmation is pending. Retry acceptance to reconcile it safely. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }

  // The booking state and the provider event are authoritative. A sync repairs
  // this optional optimistic mirror if the local write is transiently unavailable.
  try {
    await ctx.runMutation(internal.calendar.upsertEvent, {
      userId: user._id,
      event,
    });
  } catch (error) {
    console.error("[booking] provider accepted event; mirror pending", error);
  }
  return null;
}
