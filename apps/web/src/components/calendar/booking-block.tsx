import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";

import type { Booking } from "@/components/workspace/booking-request-panel";

import { msToPct, MS_PER_MINUTE } from "./lib";
import { RevealFlash, type Reveal } from "./today-pulse";

/**
 * Below this the block gets one line instead of two.
 *
 * Sized against the worst case: a day column is 24 hours tall at a floor of
 * MIN_HOUR_HEIGHT (40px), so an hour is 40px and a 30-minute request is 20px. The
 * two-line layout needs ~29px of text plus 6px of border and padding, which only
 * clears at a full hour — at 45 minutes it shaves the glyphs off both lines. A
 * taller viewport stretches the hour and gives more room, so keying off the floor
 * is the safe direction to be wrong in.
 */
const COMPACT_BELOW_MINUTES = 60;

/**
 * One pending appointment request on the time grid: full column width, dashed
 * and tinted so it reads as provisional next to the solid event cards. Clicking
 * it hands the request to the dock, where it can be confirmed or declined.
 *
 * Full width is safe because the server only ever offers slots it has already
 * subtracted the host's busy time from — a pending request does not land on top
 * of an existing event, so there is no clash for a narrower lane to signal.
 */
export function BookingBlock({
  booking,
  dayStartMs,
  reveal,
  onOpen,
}: {
  booking: Booking;
  dayStartMs: number;
  reveal: Reveal;
  onOpen: () => void;
}) {
  const topPct = msToPct(Math.max(booking.startMs, dayStartMs), dayStartMs);
  const bottomPct = msToPct(booking.endMs, dayStartMs);
  const compact =
    (booking.endMs - booking.startMs) / MS_PER_MINUTE < COMPACT_BELOW_MINUTES;
  const startLabel = format(booking.startMs, "HH:mm");

  return (
    <button
      type="button"
      // `data-event` opts this into the dock's "another card took over" path, so
      // clicking straight from an event to a request doesn't flash the nav row.
      data-event
      onClick={onOpen}
      aria-label={`Request from ${booking.requesterName}, ${format(
        booking.startMs,
        "EEE d MMM HH:mm",
      )}`}
      className={cn(
        "absolute inset-x-1 z-20 min-h-[16px] overflow-hidden rounded-md border border-dashed border-primary/60 bg-primary/10 text-left outline-none backdrop-blur-[1px] transition-colors",
        "hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring",
        compact
          ? "flex items-center gap-1.5 px-1.5 py-0"
          : "flex flex-col px-1.5 py-0.5",
      )}
      style={{
        top: `${topPct}%`,
        height: `${Math.max(bottomPct - topPct, 0)}%`,
      }}
    >
      <RevealFlash
        reveal={reveal}
        targetId={booking._id}
        className="rounded-md bg-primary/25"
      />
      {compact ? (
        // `leading-tight`, not `leading-none`: `truncate` brings overflow:hidden
        // with it, and an 11px line box is shorter than the font's own glyph box,
        // so a tighter leading shaves the ascenders and descenders off the name.
        <>
          <span className="min-w-0 flex-1 truncate text-[11px] leading-tight font-medium text-primary">
            {booking.requesterName}
          </span>
          <span className="shrink-0 text-[11px] leading-tight text-primary/80">
            {startLabel}
          </span>
        </>
      ) : (
        <>
          <span className="truncate text-xs leading-tight font-medium text-primary">
            {booking.requesterName}
          </span>
          <span className="truncate text-[11px] leading-tight text-primary/80">
            Requested · {startLabel}
          </span>
        </>
      )}
    </button>
  );
}
