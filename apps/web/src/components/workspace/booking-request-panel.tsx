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
import { cn } from "@qali/ui/lib/utils";
import { useAction, useMutation, useQuery } from "convex/react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useEffect, useRef, useState } from "react";
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

export function BookingRequestPanel({
  booking: snapshot,
  onClose,
}: {
  booking: Booking;
  onClose: () => void;
}) {
  // The dock holds a snapshot taken when the block was clicked; subscribe so a
  // decision made elsewhere (or a second tab) is reflected here.
  const live = useQuery(api.booking.listMyBookings, {
    startMs: snapshot.startMs,
    endMs: snapshot.endMs + 1,
  });
  const booking = live?.find((b) => b._id === snapshot._id) ?? snapshot;
  const { decide, busy } = useBookingDecision(onClose);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {booking.requesterName}
          </p>
          <p className="text-xs text-muted-foreground">
            {bookingTimeLabel(booking)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
        </button>
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
            : "Declined."}
        </p>
      )}
    </div>
  );
}

/** Card width as a share of the deck, leaving the rest of the track for the next
 * card to poke out of — that peek is the only affordance saying "there is more
 * this way", so it has to stay visible rather than being tuned away. */
const CARD_WIDTH_PCT = 84;
const CARD_GAP_PX = 8;

/**
 * Pending requests as a horizontal deck: one card at a time, the next poking out
 * on the right, scroll-snapped.
 *
 * A vertical list was the obvious first shape and the wrong one — it grew the
 * dock by a row per request, so a popular link pushed the settings below it off
 * screen. The deck is a fixed height whatever the count, and pays for it with a
 * peek and a counter instead of showing everything at once.
 */
export function PendingRequestsDeck({
  onOpen,
}: {
  onOpen: (booking: Booking) => void;
}) {
  const pending = useQuery(api.booking.listPendingBookings) ?? [];
  const { decide, busy } = useBookingDecision(() => {});
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Derive the active card from scroll position rather than tracking it on
  // click, so a flick, a keyboard scroll and the arrows all agree.
  const onScroll = () => {
    const scroller = scrollerRef.current;
    const first = scroller?.firstElementChild as HTMLElement | null;
    if (!scroller || !first) return;
    const step = first.offsetWidth + CARD_GAP_PX;
    const count = scroller.children.length;
    // The last card can never sit flush left: the track is wider than one card,
    // so max scroll stops short of `(count - 1) * step` by exactly the peek. Read
    // the end off the scroll extent instead of trusting the division to round up
    // — otherwise the counter never reaches n/n and the next arrow never
    // disables, and whether it does depends on CARD_WIDTH_PCT.
    const atEnd = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft <= 1;
    setActiveIndex(
      atEnd ? count - 1 : Math.min(Math.round(scroller.scrollLeft / step), count - 1),
    );
  };

  const scrollToIndex = (index: number) => {
    const scroller = scrollerRef.current;
    const first = scroller?.firstElementChild as HTMLElement | null;
    if (!scroller || !first) return;
    const clamped = Math.max(0, Math.min(index, pending.length - 1));
    scroller.scrollTo({
      left: clamped * (first.offsetWidth + CARD_GAP_PX),
      behavior: "smooth",
    });
  };

  // A decision removes a card, which can leave the deck scrolled past its end.
  useEffect(() => {
    if (activeIndex > pending.length - 1) {
      setActiveIndex(Math.max(0, pending.length - 1));
      scrollToIndex(pending.length - 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length]);

  if (pending.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1 px-2">
        <p className="flex-1 text-xs font-medium text-muted-foreground">
          {pending.length === 1 ? "1 request" : `${pending.length} requests`}
        </p>
        {pending.length > 1 && (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">
              {activeIndex + 1}/{pending.length}
            </span>
            <DeckArrow
              icon={ArrowLeft01Icon}
              label="Previous request"
              disabled={activeIndex === 0}
              onClick={() => scrollToIndex(activeIndex - 1)}
            />
            <DeckArrow
              icon={ArrowRight01Icon}
              label="Next request"
              disabled={activeIndex === pending.length - 1}
              onClick={() => scrollToIndex(activeIndex + 1)}
            />
          </>
        )}
      </div>

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-p-1 px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {pending.map((booking, index) => (
          <RequestCard
            key={booking._id}
            booking={booking}
            active={index === activeIndex}
            busy={busy}
            onOpen={() => onOpen(booking)}
            onDecide={(decision) => decide(booking, decision)}
            onFocus={() => scrollToIndex(index)}
          />
        ))}
      </div>
    </div>
  );
}

function DeckArrow({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof ArrowLeft01Icon;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4" />
    </button>
  );
}

/** One request in the deck. Fixed height so the dock never resizes as the deck
 * is paged; the cards behind recede vertically, which is what reads as a stack
 * rather than as a row that happens to be clipped. */
function RequestCard({
  booking,
  active,
  busy,
  onOpen,
  onDecide,
  onFocus,
}: {
  booking: Booking;
  active: boolean;
  busy: "accept" | "reject" | null;
  onOpen: () => void;
  onDecide: (decision: "accept" | "reject") => void;
  onFocus: () => void;
}) {
  const minutes = Math.round((booking.endMs - booking.startMs) / 60_000);

  return (
    <div
      // Tabbing into a card that is off to the side should bring it into view,
      // otherwise the focus ring lands somewhere nobody can see.
      onFocus={onFocus}
      className={cn(
        "relative flex h-[164px] shrink-0 snap-start flex-col overflow-hidden rounded-2xl border border-border bg-muted/60 pr-3 pl-3.5 transition-[transform,opacity] duration-200",
        active ? "opacity-100" : "scale-y-[0.94] opacity-60",
      )}
      style={{ width: `${CARD_WIDTH_PCT}%` }}
    >
      <span
        aria-hidden
        className="absolute top-3 bottom-3 left-1 w-[3px] rounded-full bg-primary/70"
      />

      <button
        type="button"
        onClick={onOpen}
        className="-mx-1 mt-2.5 min-w-0 rounded-lg px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <p className="truncate text-sm font-medium">{booking.requesterName}</p>
        <p className="truncate text-xs text-muted-foreground">
          {booking.requesterEmail}
        </p>
      </button>

      <div className="mt-2 space-y-0.5">
        <p className="flex items-center gap-1.5 text-xs">
          <HugeiconsIcon
            icon={Clock01Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate">
            {bookingTimeLabel(booking)} · {minutes}m
          </span>
        </p>
        <p className="truncate pl-5 text-[11px] text-muted-foreground">
          asked {formatDistanceToNowStrict(booking.createdAt, { addSuffix: true })}
          {" · "}
          {booking.timeZone.replace(/_/g, " ")}
        </p>
      </div>

      {/* `min-h-0` so the note is what gives way when it is long, rather than the
          buttons being pushed out of the fixed-height card. */}
      <div className="mt-1.5 min-h-0 flex-1">
        {booking.note ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {booking.note}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/60">No message</p>
        )}
      </div>

      <div className="flex items-center gap-1.5 pb-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="flex-1"
          disabled={busy !== null}
          onClick={() => onDecide("reject")}
        >
          {busy === "reject" ? <Spinner /> : null}
          Decline
        </Button>
        <Button
          type="button"
          size="sm"
          className="flex-1"
          disabled={busy !== null}
          onClick={() => onDecide("accept")}
        >
          {busy === "accept" ? <Spinner /> : null}
          Confirm
        </Button>
      </div>
    </div>
  );
}
