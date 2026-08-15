import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DayInterval } from "@qali/domain/availability";
import { cn } from "@qali/ui/lib/utils";
import { motion, useReducedMotion } from "motion/react";

import {
  formatWallClockMinutes,
  msToPct,
  MS_PER_MINUTE,
} from "./lib";

/**
 * One painted availability span on the time grid, shown only while setting
 * availability. Green so it reads as "open" next to the neutral event cards and
 * dashed booking blocks; clicking it removes that span from the day.
 *
 * `saving` is the middle state between drawing and the write landing: the block
 * is already on the grid (drawn optimistically) but a shimmer sweeps across it
 * until the override is committed, so a span never blinks out and back.
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
      aria-label={`Remove availability ${formatWallClockMinutes(interval.startMin)} to ${formatWallClockMinutes(interval.endMin)}`}
      className={cn(
        "group absolute inset-x-1 z-20 flex min-h-[16px] origin-center overflow-hidden rounded-md border border-chart-2/50 bg-chart-2/15 text-left outline-none transition-colors",
        "hover:bg-chart-2/25 focus-visible:ring-2 focus-visible:ring-ring",
      )}
      style={{ top: `${topPct}%`, height: `${Math.max(heightPct, 0)}%` }}
    >
      {saving &&
        (reduce ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 animate-pulse bg-chart-2/10"
          />
        ) : (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 -inset-x-1"
            style={{
              background:
                "linear-gradient(100deg, transparent 30%, color-mix(in oklab, var(--chart-2) 40%, transparent) 50%, transparent 70%)",
            }}
            initial={{ x: "-60%" }}
            animate={{ x: "60%" }}
            transition={{ repeat: Infinity, duration: 1.15, ease: "easeInOut" }}
          />
        ))}
      <span className="relative flex w-full items-start justify-between gap-1 px-1.5 py-0.5">
        <span className="min-w-0 truncate text-[11px] leading-tight font-medium text-chart-2">
          {formatWallClockMinutes(interval.startMin, false)} –{" "}
          {formatWallClockMinutes(interval.endMin)}
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
