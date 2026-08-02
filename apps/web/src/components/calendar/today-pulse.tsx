import { cn } from "@qali/ui/lib/utils";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

import { TODAY_FLASH } from "./motion";

interface TodayFlashProps {
  /** Increments on each Today click; a change replays the flash. */
  token: number;
  /** Highlight colour + border-radius classes for the overlay. */
  className?: string;
}

/** An absolutely-positioned overlay that softly pulses its background whenever
 * `token` changes — i.e. after a Today jump settles. Drop it into any
 * `relative` container (today's date pill or month cell). Fires only on change
 * (not on mount or when today pages back into view) and is skipped for reduced
 * motion. */
export function TodayFlash({ token, className }: TodayFlashProps) {
  const controls = useAnimationControls();
  const reduce = useReducedMotion();
  const prevToken = useRef(token);

  useEffect(() => {
    if (token === prevToken.current) return;
    prevToken.current = token;
    if (reduce) return;
    controls.set({ opacity: 0 });
    void controls.start({
      ...TODAY_FLASH.keyframes,
      transition: TODAY_FLASH.transition,
    });
  }, [token, reduce, controls]);

  return (
    <motion.span
      aria-hidden
      initial={{ opacity: 0 }}
      animate={controls}
      className={cn("pointer-events-none absolute inset-0", className)}
    />
  );
}
