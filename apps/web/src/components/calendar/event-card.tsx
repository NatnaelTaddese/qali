import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";
import { motion } from "motion/react";
import type { ComponentProps } from "react";

import { eventColorVar, MS_PER_HOUR, type PositionedEvent } from "./lib";
import { pressTransition } from "./motion";

interface EventCardProps extends ComponentProps<typeof motion.div> {
  positioned: PositionedEvent;
}

export function EventCard({ positioned, className, style, ...props }: EventCardProps) {
  const { event, topPct, heightPct, leftPct, widthPct } = positioned;
  const colorVar = eventColorVar(event);
  // Show the time line only for events long enough to have room for it.
  const showTime = event.endMs - event.startMs >= MS_PER_HOUR;
  return (
    <motion.div
      data-event
      whileTap={{ scale: 0.97 }}
      transition={{ scale: pressTransition }}
      className={cn(
        "absolute z-10 min-h-[13px] cursor-pointer overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 ring-1 ring-border/60",
        className,
      )}
      style={{
        top: `${topPct}%`,
        height: `${heightPct}%`,
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
        backgroundColor: `color-mix(in oklab, var(${colorVar}) 22%, var(--card))`,
        borderLeftColor: `var(${colorVar})`,
        ...style,
      }}
      {...props}
    >
      <p className="truncate text-xs font-medium leading-tight">
        {event.summary ?? "(No title)"}
      </p>
      {showTime && (
        <p className="truncate text-[11px] leading-tight text-muted-foreground">
          {format(event.startMs, "h:mm")} – {format(event.endMs, "h:mm a")}
        </p>
      )}
    </motion.div>
  );
}
