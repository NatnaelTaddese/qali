import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";

import { msToPct } from "./lib";

interface GhostEventProps {
  startMs: number;
  endMs: number;
  dayStartMs: number;
  pending: boolean;
}

export function GhostEvent({ startMs, endMs, dayStartMs, pending }: GhostEventProps) {
  const topPct = msToPct(startMs, dayStartMs);
  const heightPct = msToPct(endMs, dayStartMs) - topPct;
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
          : `${format(startMs, "h:mm")} – ${format(endMs, "h:mm a")}`}
      </p>
    </div>
  );
}
