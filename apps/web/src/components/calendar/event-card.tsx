import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";
import { motion } from "motion/react";
import type { ComponentProps } from "react";

import { useEventColor } from "./colors";
import { type PositionedEvent, stackIndentPx } from "./lib";
import { pressTransition } from "./motion";

interface EventCardProps extends ComponentProps<typeof motion.div> {
  positioned: PositionedEvent;
}

export function EventCard({ positioned, className, style, ...props }: EventCardProps) {
  const { event, topPct, heightPct, stackIndex } = positioned;
  const colorFor = useEventColor();
  const colorVar = colorFor(event);
  // Overlapping events cascade: each deeper card is indented right and its right
  // edge stays pinned to the column, so cards behind peek out on the left and a
  // later event paints on top of the ones it overlaps.
  const indent = stackIndentPx(stackIndex);
  // The card is a size-query container (see `.event-card` in globals.css): the
  // start time and title shrink out as the rendered height gets small, so short
  // events stay legible instead of clipping the title. This tracks actual
  // pixels, so a short event regains its detail lines when the grid is zoomed.
  return (
    <motion.div
      data-event
      whileTap={{ scale: 0.97 }}
      transition={{ scale: pressTransition }}
      className={cn(
        "event-card absolute min-h-[13px] cursor-pointer overflow-hidden rounded-lg ring-1 ring-border/60 inset-ring inset-ring-black/10 dark:inset-ring-white/10",
        className,
      )}
      style={{
        top: `${topPct}%`,
        height: `${heightPct}%`,
        left: `calc(${indent}px + 2px)`,
        width: `calc(100% - ${indent}px - 4px)`,
        zIndex: 10 + stackIndex,
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
      <div className="event-card-body flex h-full flex-col justify-start py-1 pr-2 pl-3">
        <p className="event-card-title line-clamp-2 text-sm font-medium leading-tight">
          {event.summary ?? "(No title)"}
        </p>
        <p className="event-card-time truncate text-xs leading-tight text-muted-foreground">
          {format(event.startMs, "h:mm a")}
        </p>
      </div>
    </motion.div>
  );
}
