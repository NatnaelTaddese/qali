import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";
import { motion } from "motion/react";
import type { ComponentProps } from "react";

import { useEventColor } from "./colors";
import { MS_PER_MINUTE, type PositionedEvent } from "./lib";
import { pressTransition } from "./motion";

/** Shortest event that still has room for the time line under the title. */
const TIME_LINE_MIN_MS = 30 * MS_PER_MINUTE;

interface EventCardProps extends ComponentProps<typeof motion.div> {
  positioned: PositionedEvent;
}

export function EventCard({ positioned, className, style, ...props }: EventCardProps) {
  const { event, topPct, heightPct, leftPct, widthPct } = positioned;
  const colorFor = useEventColor();
  const colorVar = colorFor(event);
  const showTime = event.endMs - event.startMs >= TIME_LINE_MIN_MS;
  return (
    <motion.div
      data-event
      whileTap={{ scale: 0.97 }}
      transition={{ scale: pressTransition }}
      className={cn(
        "absolute z-10 min-h-[13px] cursor-pointer overflow-hidden rounded-lg py-1 pr-2 pl-3 ring-1 ring-border/60",
        className,
      )}
      style={{
        top: `${topPct}%`,
        height: `${heightPct}%`,
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
        backgroundColor: `color-mix(in oklab, var(${colorVar}) 22%, var(--card))`,
        ...style,
      }}
      {...props}
    >
      <span
        aria-hidden
        className="absolute top-1 bottom-1 left-1 w-[3px] rounded-full"
        style={{ backgroundColor: `var(${colorVar})` }}
      />
      <p className="truncate text-sm font-medium leading-snug">
        {event.summary ?? "(No title)"}
      </p>
      {showTime && (
        <p className="truncate text-xs leading-snug text-muted-foreground">
          {format(event.startMs, "h:mm a")}
        </p>
      )}
    </motion.div>
  );
}
