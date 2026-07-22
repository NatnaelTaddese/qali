import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";
import { motion } from "motion/react";

import { useEventColor } from "./colors";
import { type PositionedEvent, stackIndentPx } from "./lib";
import { pressTransition } from "./motion";
import type { DragMode } from "./use-event-drag";

interface EventCardProps {
  positioned: PositionedEvent;
  /** True while this card is the one being moved/resized. */
  isDragging: boolean;
  /** Begin a gesture; the mode is derived from where the press landed. */
  onDragStart: (mode: DragMode, e: React.PointerEvent) => void;
}

/** Pick the gesture from the press target: the edge handles resize, the body
 * moves the whole event. */
function modeForTarget(target: EventTarget | null): DragMode {
  const el = target as HTMLElement | null;
  if (el?.closest("[data-resize-top]")) return "resize-start";
  if (el?.closest("[data-resize-bottom]")) return "resize-end";
  return "move";
}

export function EventCard({ positioned, isDragging, onDragStart }: EventCardProps) {
  const { event, topPct, heightPct, stackIndex, elevation } = positioned;
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
      onPointerDown={(e) => onDragStart(modeForTarget(e.target), e)}
      whileTap={isDragging ? undefined : { scale: 0.97 }}
      transition={{ scale: pressTransition }}
      className={cn(
        "event-card group absolute min-h-[13px] cursor-grab overflow-hidden rounded-lg shadow-sm ring-1 ring-border/60 inset-ring inset-ring-black/10 select-none dark:inset-ring-white/10",
        isDragging &&
          "cursor-grabbing touch-none shadow-lg ring-2 ring-primary/60",
      )}
      style={{
        top: `${topPct}%`,
        height: `${heightPct}%`,
        left: `calc(${indent}px + 2px)`,
        width: `calc(100% - ${indent}px - 4px)`,
        zIndex: isDragging ? 50 : 10 + elevation,
        backgroundColor: `color-mix(in oklab, var(${colorVar}) 22%, var(--card))`,
      }}
    >
      <span
        aria-hidden
        className="absolute top-1 bottom-1 left-1 w-[3px] rounded-full"
        style={{ backgroundColor: `var(${colorVar})` }}
      />
      <div className="event-card-body flex h-full flex-col justify-start py-1 pr-2 pl-3">
        <p className="event-card-title text-sm font-medium leading-tight">
          {event.summary ?? "(No title)"}
        </p>
        <p className="event-card-time truncate text-xs leading-tight text-muted-foreground">
          {`${format(event.startMs, "h:mm")} – ${format(event.endMs, "h:mm a")}`}
        </p>
      </div>
      {/* Edge handles for resizing start/end. Invisible until hover so they
          don't clutter the card, but always hit-testable. */}
      <span
        data-resize-top
        aria-hidden
        className="absolute inset-x-0 top-0 h-2 cursor-ns-resize touch-none"
      />
      <span
        data-resize-bottom
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize touch-none"
      />
    </motion.div>
  );
}
