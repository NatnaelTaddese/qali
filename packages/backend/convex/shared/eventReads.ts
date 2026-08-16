/**
 * Shared tuning for the two range/overlap reads — the calendar range query
 * (`calendar.listEventsInRange`) and the booking busy scan (`booking.collectBusy`).
 *
 * An event overlaps a window [from, to) iff `endMs > from && startMs < to`. Both
 * reads range an `endMs` index (`endMs > from`) rather than a `startMs` index, so
 * an event that *started* long before the window but is still running is caught —
 * the case the old 24-hour start-index lookback silently dropped. The far side is
 * bounded by `to + MAX_EVENT_SPAN_MS` so the scan stays near the window instead of
 * reading every future event, and `startMs < to` is applied as a post-filter.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** How far past a window's end the overlap scan still looks. An event longer than
 * this that starts before the window is missed — the residual limitation that
 * replaces the far tighter (and far more commonly wrong) 24-hour lookback. Ninety
 * days comfortably covers vacations, courses, and multi-week all-day spans. */
export const MAX_EVENT_SPAN_MS = 90 * MS_PER_DAY;

/** Most rows a single range/busy read will touch before refusing the request.
 * Legitimate windows (≤214d calendar, ≤35d booking) sit orders of magnitude
 * below this, so tripping it means a forged or pathological range — not a real
 * calendar — and we fail loudly rather than return a silently partial answer. */
export const RANGE_DENSITY_LIMIT = 5000;

/** Thrown when one range/busy read would exceed {@link RANGE_DENSITY_LIMIT}. */
export class RangeTooDenseError extends Error {
  constructor() {
    super("Requested calendar range is too dense");
    this.name = "RangeTooDenseError";
  }
}

/** A mutable row budget shared across the several index reads that make up one
 * logical range/busy query, so the ceiling bounds their combined cost. */
export interface RowBudget {
  remaining: number;
}

export function newRowBudget(): RowBudget {
  return { remaining: RANGE_DENSITY_LIMIT };
}

/** Charge `count` rows against the budget, refusing the whole read if it would go
 * negative. Callers `.take(budget.remaining + 1)` so a full page proves the
 * ceiling was exceeded. */
export function spendRowBudget(budget: RowBudget, count: number): void {
  if (count > budget.remaining) {
    throw new RangeTooDenseError();
  }
  budget.remaining -= count;
}
