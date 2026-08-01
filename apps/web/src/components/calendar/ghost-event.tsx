import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";

import { formatWallClockMinutes, msToPct, MS_PER_MINUTE } from "./lib";

interface GhostEventProps {
  startMs: number;
  endMs: number;
  dayStartMs: number;
  pending: boolean;
  wallClock?: boolean;
}

export function GhostEvent({
  startMs,
  endMs,
  dayStartMs,
  pending,
  wallClock = false,
}: GhostEventProps) {
  const topPct = msToPct(startMs, dayStartMs);
  const heightPct = msToPct(endMs, dayStartMs) - topPct;
  const rangeLabel = wallClock
    ? `${formatWallClockMinutes(
        (startMs - dayStartMs) / MS_PER_MINUTE,
        false,
      )} – ${formatWallClockMinutes((endMs - dayStartMs) / MS_PER_MINUTE)}`
    : `${format(startMs, "h:mm")} – ${format(endMs, "h:mm a")}`;
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-1 z-30 min-h-[14px] rounded-md border border-dashed border-primary/40 bg-primary/10 px-2 py-0.5",
        pending && "animate-pulse border-solid",
      )}
      style={{ top: `${topPct}%`, height: `${heightPct}%` }}
    >
      <p className="truncate text-xs font-medium text-primary">
        {pending
          ? "New event"
          : rangeLabel}
      </p>
    </div>
  );
}
