import { cn } from "@qali/ui/lib/utils";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

import { REVEAL_FLASH } from "./motion";

/** A destination the calendar has been asked to reach for. `id` is the target
 * item's key (an event `_id`/`googleEventId`, a booking `_id`, or a day key);
 * `nonce` increments on every reveal so the same target can flash again. */
export interface Reveal {
  id: string | null;
  nonce: number;
}

/** The quiet initial state: nothing revealed yet. */
export const NO_REVEAL: Reveal = { id: null, nonce: 0 };

interface RevealFlashProps {
  /** The active reveal, threaded down from the calendar. */
  reveal: Reveal;
  /** This item's key(s); the flash plays when `reveal.id` matches any of them.
   * An array covers items with more than one natural key — an event is reached
   * for by either its Convex `_id` or its `googleEventId`. */
  targetId: string | readonly string[];
  /** Highlight colour + border-radius classes for the overlay. */
  className?: string;
}

/** An absolutely-positioned overlay that softly pulses its background whenever
 * this item becomes the reveal target — i.e. after a scroll to it settles. Drop
 * it into any `relative` container (a date pill, event card, or request block).
 *
 * It fires for each new `nonce` it hasn't played, **including on mount**: a card
 * that mounts already matching the active reveal (e.g. an assistant change that
 * syncs in after the reveal was issued) still flashes. Skipped for reduced
 * motion. */
export function RevealFlash({ reveal, targetId, className }: RevealFlashProps) {
  const controls = useAnimationControls();
  const reduce = useReducedMotion();
  // The last nonce this item played. Starts below any real nonce (which are
  // >= 1) so a mount that already matches an unplayed reveal fires once.
  const lastPlayed = useRef(-1);

  // -1 when this item isn't the target, so it never matches `lastPlayed` and
  // never plays; a matching reveal carries a nonce >= 1.
  const matches =
    reveal.id != null &&
    (Array.isArray(targetId)
      ? targetId.includes(reveal.id)
      : targetId === reveal.id);
  const active = matches ? reveal.nonce : -1;

  useEffect(() => {
    if (active < 0 || active === lastPlayed.current) return;
    lastPlayed.current = active;
    if (reduce) return;
    controls.set({ opacity: 0 });
    void controls.start({
      ...REVEAL_FLASH.keyframes,
      transition: REVEAL_FLASH.transition,
    });
  }, [active, reduce, controls]);

  return (
    <motion.span
      aria-hidden
      initial={{ opacity: 0 }}
      animate={controls}
      className={cn("pointer-events-none absolute inset-0", className)}
    />
  );
}
