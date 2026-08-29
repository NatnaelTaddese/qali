import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";

import { usePreferences } from "@/components/workspace/preferences-context";
import {
  formatWallClockMinutes,
  msToPct,
  MS_PER_MINUTE,
  timePattern,
} from "./lib";

interface GhostEventProps {
  startMs: number;
  endMs: number;
  dayStartMs: number;
  pending: boolean;
  wallClock?: boolean;
  /** `paint` borrows the availability palette so a span being painted never
   * reads as a pending event — the two gestures look alike otherwise. */
  variant?: "create" | "paint";
}

export function GhostEvent({
  startMs,
  endMs,
  dayStartMs,
  pending,
  wallClock = false,
  variant = "create",
}: GhostEventProps) {
  const { use24h } = usePreferences();
  const topPct = msToPct(startMs, dayStartMs);
  const heightPct = msToPct(endMs, dayStartMs) - topPct;
  const rangeLabel = wallClock
    ? `${formatWallClockMinutes(
        (startMs - dayStartMs) / MS_PER_MINUTE,
        false,
        use24h,
      )} – ${formatWallClockMinutes((endMs - dayStartMs) / MS_PER_MINUTE, true, use24h)}`
    : `${format(startMs, timePattern(use24h, false))} – ${format(endMs, timePattern(use24h))}`;
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-1 z-30 min-h-[14px] rounded-md border border-dashed px-2 py-0.5",
        variant === "paint"
          ? "border-chart-2/50 bg-chart-2/15"
          : "border-primary/40 bg-primary/10",
        pending && "animate-pulse border-solid",
      )}
      style={{ top: `${topPct}%`, height: `${heightPct}%` }}
    >
      <p
        className={cn(
          "truncate text-xs font-medium",
          variant === "paint" ? "text-chart-2" : "text-primary",
        )}
      >
        {pending
          ? "New event"
          : rangeLabel}
      </p>
    </div>
  );
}
