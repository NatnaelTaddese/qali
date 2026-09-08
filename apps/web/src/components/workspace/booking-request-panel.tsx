import {
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

import { timePattern, zoned } from "@/components/calendar/lib";
import { usePreferences } from "./preferences-context";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { SPRING_DOCK } from "@/components/calendar/motion";

export type Booking = Doc<"bookings">;

/**
 * Accept/reject for one appointment request.
 *
 * Accepting is an action: it writes the event to Google with the requester as a
 * guest, and Google is what emails them. Rejecting only flips the row — the
 * requester sees it through the link they already have.
 */
type BookingDecision = "accept" | "reject";
const COLLAPSED_NOTE_LINES = 3;
const COLLAPSED_NOTE_HEIGHT = "3.75rem";

function useBookingDecision(onDone: (booking: Booking) => void) {
  const acceptBooking = useAction(api.domains.booking.service.acceptBooking);
  const rejectBooking = useMutation(api.domains.booking.mutations.rejectBooking);
  const [busy, setBusy] = useState<{
    bookingId: Booking["_id"];
    decision: BookingDecision;
  } | null>(null);

  const decide = async (booking: Booking, decision: BookingDecision) => {
    if (busy) return;
    setBusy({ bookingId: booking._id, decision });
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
      onDone(booking);
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

/** "Mon, Aug 3 · 10:00 AM – 10:30 AM", in the host's working zone and clock. */
export function bookingTimeLabel(
  booking: Booking,
  timeZone: string,
  use24h: boolean,
): string {
  const time = timePattern(use24h);
  const start = zoned(booking.startMs, timeZone);
  return `${format(start, "EEE, MMM d")} · ${format(
    start,
    time,
  )} – ${format(zoned(booking.endMs, timeZone), time)}`;
}

export function BookingRequestPanel({
  booking: snapshot,
  onClose,
}: {
  booking: Booking;
  onClose: () => void;
}) {
  // The dock holds a snapshot taken when the block was clicked; subscribe so a
  // decision made elsewhere (or a second tab) is reflected here.
  const live = useQuery(api.domains.booking.queries.listMyBookings, {
    startMs: snapshot.startMs,
    endMs: snapshot.endMs + 1,
  });
  const booking = live?.find((b) => b._id === snapshot._id) ?? snapshot;
  const { timeZone, use24h } = usePreferences();
  const { decide, busy } = useBookingDecision(onClose);
  const activeDecision = busy?.bookingId === booking._id ? busy.decision : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {booking.requesterName}
          </p>
          <p className="text-xs text-muted-foreground">
            {bookingTimeLabel(booking, timeZone, use24h)}
          </p>
        </div>
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
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <HugeiconsIcon icon={Mail01Icon} strokeWidth={2} className="size-4" />
        <span className="truncate">{booking.requesterEmail}</span>
      </div>

      {booking.note && (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] text-muted-foreground">
            Their message — written by the visitor, not verified
          </p>
          <p className="rounded-2xl bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
            {booking.note}
          </p>
        </div>
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
            {activeDecision === "reject" ? <Spinner /> : null}
            Decline
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => decide(booking, "accept")}
          >
            {activeDecision === "accept" ? <Spinner /> : null}
            {activeDecision === "accept" ? "Confirming…" : "Confirm"}
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
  onDone,
}: {
  pending: Booking[];
  onDone: (booking: Booking) => void;
}) {
  const { decide, busy } = useBookingDecision(onDone);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollFade, setScrollFade] = useState({ top: false, bottom: false });

  const updateScrollFade = () => {
    const list = listRef.current;
    if (!list) return;
    const next = {
      top: list.scrollTop > 0,
      bottom: list.scrollTop + list.clientHeight < list.scrollHeight - 1,
    };
    setScrollFade((current) =>
      current.top === next.top && current.bottom === next.bottom
        ? current
        : next,
    );
  };

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    updateScrollFade();
    const observer = new ResizeObserver(updateScrollFade);
    observer.observe(list);
    for (const card of list.children) observer.observe(card);
    return () => observer.disconnect();
  }, [pending]);

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={listRef}
        onScroll={updateScrollFade}
        className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1 scrollbar-gutter-stable"
      >
        {pending.map((booking) => (
          <RequestCard
            key={booking._id}
            booking={booking}
            busy={busy}
            onDecide={(decision) => decide(booking, decision)}
          />
        ))}
        {pending.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            No pending requests
          </div>
        )}
      </div>
      {scrollFade.top && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 right-3 left-0 h-10 bg-linear-to-b from-popover to-transparent"
        />
      )}
      {scrollFade.bottom && (
        <div
          aria-hidden
          className="pointer-events-none absolute right-3 bottom-0 left-0 h-10 bg-linear-to-t from-popover to-transparent"
        />
      )}
    </div>
  );
}

function RequestCard({
  booking,
  busy,
  onDecide,
}: {
  booking: Booking;
  busy: {
    bookingId: Booking["_id"];
    decision: BookingDecision;
  } | null;
  onDecide: (decision: BookingDecision) => void;
}) {
  const reduce = useReducedMotion();
  const { timeZone, use24h } = usePreferences();
  const noteRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState<boolean>();
  const activeDecision = busy?.bookingId === booking._id ? busy.decision : null;

  useEffect(() => {
    const note = noteRef.current;
    if (!note) return;

    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(note).lineHeight);
      setCanExpand(note.scrollHeight > lineHeight * COLLAPSED_NOTE_LINES + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(note);
    return () => observer.disconnect();
  }, [booking.note]);

  return (
    <article className="relative flex min-h-[180px] shrink-0 flex-col rounded-2xl border border-border bg-muted/50 px-3.5 py-3">
      <span
        aria-hidden
        className="absolute top-3 bottom-3 left-1 w-[3px] rounded-full bg-primary/70"
      />

      <div className="flex items-start gap-2 pl-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {booking.requesterName}
          </p>
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <HugeiconsIcon
              icon={Mail01Icon}
              strokeWidth={2}
              className="size-3.5 shrink-0"
            />
            <span className="truncate">{booking.requesterEmail}</span>
          </p>
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatDistanceToNowStrict(booking.createdAt, { addSuffix: true })}
        </span>
      </div>

      <div className="mt-2 space-y-0.5 pl-1 text-xs">
        <p className="flex items-center gap-1.5">
          <HugeiconsIcon
            icon={Clock01Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate">{bookingTimeLabel(booking, timeZone, use24h)}</span>
        </p>
        <p className="pl-5 text-[11px] text-muted-foreground">
          Requester's timezone: {booking.timeZone.replace(/_/g, " ")}
        </p>
      </div>

      <div className="mt-2 pl-1">
        {booking.note ? (
          <>
            <p className="mb-1 text-[11px] text-muted-foreground">
              Their message — written by the visitor, not verified
            </p>
            <motion.div
              initial={false}
              animate={{
                height:
                  expanded || canExpand === false
                    ? "auto"
                    : COLLAPSED_NOTE_HEIGHT,
              }}
              transition={reduce ? { duration: 0 } : SPRING_DOCK}
              className="overflow-hidden"
            >
              <p
                ref={noteRef}
                className="text-sm leading-5 whitespace-pre-wrap text-foreground/90"
              >
                {booking.note}
              </p>
            </motion.div>
            {(canExpand || expanded) && (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="mt-1 rounded text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground/60">No message</p>
        )}
      </div>

      <div className="mt-auto flex items-center gap-1.5 pt-3 pl-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex-1"
          disabled={busy !== null}
          onClick={() => onDecide("reject")}
        >
          {activeDecision === "reject" ? <Spinner /> : null}
          Decline
        </Button>
        <Button
          type="button"
          size="sm"
          className="flex-1"
          disabled={busy !== null}
          onClick={() => onDecide("accept")}
        >
          {activeDecision === "accept" ? <Spinner /> : null}
          {activeDecision === "accept" ? "Confirming…" : "Confirm"}
        </Button>
      </div>
    </article>
  );
}
