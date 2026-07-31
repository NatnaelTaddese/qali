import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Clock01Icon,
  Mail01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Doc } from "@qali/backend/convex/_generated/dataModel";
import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import { useAction, useMutation, useQuery } from "convex/react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";

export type Booking = Doc<"bookings">;

/**
 * Accept/reject for one appointment request.
 *
 * Accepting is an action: it writes the event to Google with the requester as a
 * guest, and Google is what emails them. Rejecting only flips the row — the
 * requester sees it through the link they already have.
 */
function useBookingDecision(onDone: () => void) {
  const acceptBooking = useAction(api.booking.acceptBooking);
  const rejectBooking = useMutation(api.booking.rejectBooking);
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);

  const decide = async (booking: Booking, decision: "accept" | "reject") => {
    if (busy) return;
    setBusy(decision);
    try {
      if (decision === "accept") {
        await acceptBooking({ bookingId: booking._id });
        toast.success(`Confirmed with ${booking.requesterName}`, {
          description: "Google is sending them the invitation.",
        });
      } else {
        await rejectBooking({ bookingId: booking._id });
        toast.success(`Declined ${booking.requesterName}`);
      }
      onDone();
    } catch (error: unknown) {
      toast.error(
        decision === "accept"
          ? "Couldn't confirm this request"
          : "Couldn't decline this request",
        { description: error instanceof Error ? error.message : undefined },
      );
    } finally {
      setBusy(null);
    }
  };

  return { decide, busy };
}

/** "Mon, Aug 3 · 10:00 – 10:30", in the host's own zone. */
export function bookingTimeLabel(booking: Booking): string {
  return `${format(booking.startMs, "EEE, MMM d")} · ${format(
    booking.startMs,
    "HH:mm",
  )} – ${format(booking.endMs, "HH:mm")}`;
}

type BookingRequestPanelProps =
  | {
      booking: Booking;
      onClose: () => void;
      onBack?: never;
      onDone?: never;
    }
  | {
      booking: Booking;
      onClose?: never;
      onBack: () => void;
      onDone: () => void;
    };

export function BookingRequestPanel({
  booking: snapshot,
  onClose,
  onBack,
  onDone,
}: BookingRequestPanelProps) {
  // The dock holds a snapshot taken when the block was clicked; subscribe so a
  // decision made elsewhere (or a second tab) is reflected here.
  const live = useQuery(api.booking.listMyBookings, {
    startMs: snapshot.startMs,
    endMs: snapshot.endMs + 1,
  });
  const booking = live?.find((b) => b._id === snapshot._id) ?? snapshot;
  const { decide, busy } = useBookingDecision(onDone ?? onClose);

  return (
    <div className="flex flex-col gap-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 flex items-center gap-1 self-start rounded-lg px-1 py-0.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon
            icon={ArrowLeft01Icon}
            strokeWidth={2}
            className="size-4 text-muted-foreground"
          />
          Requests
        </button>
      )}

      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {booking.requesterName}
          </p>
          <p className="text-xs text-muted-foreground">
            {bookingTimeLabel(booking)}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              strokeWidth={2}
              className="size-4"
            />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <HugeiconsIcon icon={Mail01Icon} strokeWidth={2} className="size-4" />
        <span className="truncate">{booking.requesterEmail}</span>
      </div>

      {booking.note && (
        <p className="rounded-2xl bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
          {booking.note}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        They booked this as {booking.timeZone.replace(/_/g, " ")}.
      </p>

      {booking.status === "pending" ? (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => decide(booking, "reject")}
          >
            {busy === "reject" ? <Spinner /> : null}
            Decline
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => decide(booking, "accept")}
          >
            {busy === "accept" ? <Spinner /> : null}
            {busy === "accept" ? "Confirming…" : "Confirm"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {booking.status === "accepted"
            ? "Confirmed — it's on your calendar."
            : booking.status === "expired"
              ? "This request expired."
              : "Declined."}
        </p>
      )}
    </div>
  );
}

/** A compact request inbox. The list lives on its own drill-down screen, so it
 * can scroll independently without pushing the availability settings down. */
export function PendingRequestsList({
  pending,
  onOpen,
}: {
  pending: Booking[];
  onOpen: (booking: Booking) => void;
}) {
  return (
    <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
      {pending.map((booking) => (
        <button
          key={booking._id}
          type="button"
          onClick={() => onOpen(booking)}
          className="group flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden
            className="h-10 w-[3px] shrink-0 rounded-full bg-primary/70"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {booking.requesterName}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {formatDistanceToNowStrict(booking.createdAt, {
                  addSuffix: true,
                })}
              </span>
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <HugeiconsIcon
                icon={Clock01Icon}
                strokeWidth={2}
                className="size-3.5 shrink-0"
              />
              <span className="truncate">{bookingTimeLabel(booking)}</span>
            </span>
            <span className="block truncate pl-5 text-xs text-muted-foreground">
              {booking.requesterEmail}
            </span>
          </span>
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={2}
            className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          />
        </button>
      ))}
      {pending.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No pending requests
        </div>
      )}
    </div>
  );
}
