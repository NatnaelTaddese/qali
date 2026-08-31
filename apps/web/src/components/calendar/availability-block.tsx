import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DayInterval } from "@qali/domain/availability";
import { cn } from "@qali/ui/lib/utils";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { usePreferences } from "@/components/workspace/preferences-context";
import {
  formatWallClockMinutes,
  msToPct,
  MS_PER_MINUTE,
} from "./lib";

/** How long one shimmer band takes to cross a block. Every sweep now runs to
 * its end, so this is a floor on how long a save appears to take — short enough
 * that a write landing early isn't held up, long enough to read as a sweep. */
const SWEEP_SECONDS = 0.55;

/**
 * One painted availability span on the time grid, shown only while setting
 * availability. Green so it reads as "open" next to the neutral event cards and
 * dashed booking blocks; clicking it removes that span from the day.
 *
 * `saving` is the middle state between drawing and the write landing: the block
 * is already on the grid (drawn optimistically) but a shimmer sweeps across it
 * until the override is committed, so a span never blinks out and back. The
 * write usually lands mid-sweep — on a local deployment, barely into it — so
 * `saving` only ever *opens* the shimmer; a sweep already travelling always
 * runs to its end. Cutting the band off halfway across reads as a glitch
 * rather than as the write completing.
 *
 * `data-availability` opts it out of the column's paint-drag: a pointer down on
 * a block edits the block instead of starting a new selection.
 */
export function AvailabilityBlock({
  interval,
  dayStartMs,
  saving,
  onRemove,
}: {
  interval: DayInterval;
  dayStartMs: number;
  saving?: boolean;
  onRemove: () => void;
}) {
  const reduce = useReducedMotion();
  const { use24h } = usePreferences();
  // One sweep per cycle rather than `repeat: Infinity`, so each has an end to
  // wait for; `cycle` remounts the band to send it across again.
  const [sweeping, setSweeping] = useState(saving === true);
  const [cycle, setCycle] = useState(0);
  const savingRef = useRef(saving);
  useEffect(() => {
    savingRef.current = saving;
    if (saving) setSweeping(true);
  }, [saving]);
  const startMs = dayStartMs + interval.startMin * MS_PER_MINUTE;
  const endMs = dayStartMs + interval.endMin * MS_PER_MINUTE;
  const topPct = msToPct(startMs, dayStartMs);
  const heightPct = msToPct(endMs, dayStartMs) - topPct;

  return (
    <motion.button
      type="button"
      data-availability
      onClick={onRemove}
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={
        reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 34 }
      }
      aria-label={`Remove availability ${formatWallClockMinutes(interval.startMin, true, use24h)} to ${formatWallClockMinutes(interval.endMin, true, use24h)}`}
      className={cn(
        "group absolute inset-x-1 z-20 flex min-h-[16px] origin-center overflow-hidden rounded-md border border-chart-2/50 bg-chart-2/15 text-left outline-none transition-colors",
        "hover:bg-chart-2/25 focus-visible:ring-2 focus-visible:ring-ring",
      )}
      style={{ top: `${topPct}%`, height: `${Math.max(heightPct, 0)}%` }}
    >
      {/* Reduced motion keeps the plain pulse and stops it the moment the write
          lands: asking for less animation is not asking to wait for one. */}
      {reduce
        ? saving && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 animate-pulse bg-chart-2/10"
            />
          )
        : sweeping && (
            <motion.span
              key={cycle}
              aria-hidden
              className="pointer-events-none absolute inset-y-0 -inset-x-1"
              style={{
                background:
                  "linear-gradient(100deg, transparent 30%, color-mix(in oklab, var(--chart-2) 40%, transparent) 50%, transparent 70%)",
              }}
              initial={{ x: "-60%" }}
              animate={{ x: "60%" }}
              transition={{ duration: SWEEP_SECONDS, ease: "easeInOut" }}
              onAnimationComplete={() => {
                // Still writing, so send another band across; otherwise that
                // was the last one and it crossed the whole block.
                if (savingRef.current) setCycle((c) => c + 1);
                else setSweeping(false);
              }}
            />
          )}
      <span className="relative flex w-full items-start justify-between gap-1 px-1.5 py-0.5">
        <span className="min-w-0 truncate text-[11px] leading-tight font-medium text-chart-2">
          {formatWallClockMinutes(interval.startMin, false, use24h)} –{" "}
          {formatWallClockMinutes(interval.endMin, true, use24h)}
        </span>
        <HugeiconsIcon
          icon={Cancel01Icon}
          strokeWidth={2}
          className="size-3.5 shrink-0 text-chart-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </span>
    </motion.button>
  );
}
