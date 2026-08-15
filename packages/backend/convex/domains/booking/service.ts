/**
 * Booking acceptance — the one booking operation that talks to Google, so it is
 * an action, not a mutation. The root `booking.ts` wraps this handler in a
 * Convex `action` at `api.booking.acceptBooking`.
 *
 * It reuses `calendar.createEvent`'s sequence: resolve a token through the
 * credential broker, pick the primary calendar, insert with the requester as a
 * guest and `sendUpdates:"all"` (Google's own invitation email is the
 * confirmation — we send none), then mirror the row so the card appears now.
 */

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import { googleEventIdForOperation } from "../../lib/assistantLogic";
import { getGoogleAccessToken } from "../../lib/googleCredentials";
import {
  getCalendarEvent,
  GoogleApiError,
  GoogleNetworkError,
  insertCalendarEvent,
  mapGoogleEvent,
  toGoogleTime,
} from "../../lib/google";

export async function acceptBookingHandler(
  ctx: ActionCtx,
  args: { bookingId: Id<"bookings"> },
): Promise<null> {
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
}
