import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";
import { motion } from "motion/react";

import { useEventColor } from "./colors";
import { laneBox, type PositionedEvent, stackIndentPx } from "./lib";
import { pressTransition } from "./motion";
import { useEventCapabilities } from "./permissions";
import type { DragMode } from "./use-event-drag";

interface EventCardProps {
  positioned: PositionedEvent;
  /** True while this card is the one being moved/resized. */
  isDragging: boolean;
  /** Lay overlaps out as side-by-side columns (day view) instead of the cascade
   * (week view), where the column is too narrow to subdivide. */
  laneLayout: boolean;
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

export function EventCard({
  positioned,
  isDragging,
  laneLayout,
  onDragStart,
}: EventCardProps) {
  const { event, topPct, heightPct, stackIndex, elevation, columnIndex, columnCount, columnSpan } =
    positioned;
  const colorFor = useEventColor();
  const colorVar = colorFor(event);
  // An event the user can't reschedule still opens on tap, but it shouldn't
  // offer a grab cursor or resize edges for a drag that will never happen.
  const draggable = useEventCapabilities()(event).canEdit;
  // Two overlap modes. Lanes (day view): each cluster fans into side-by-side
  // lanes that partially overlap, so a card exposes its own left edge while the
  // later card paints on top — spread out, but still visibly stacked. Cascade
  // (week view): each deeper card is indented right with its right edge pinned,
  // so cards behind peek out on the left — the column is too narrow to fan.
  const indent = stackIndentPx(stackIndex);
  const box = laneBox(columnIndex, columnCount, columnSpan);
  const horizontal = laneLayout
    ? {
        left: `calc(${box.left * 100}% + 2px)`,
        width: `calc(${box.width * 100}% - 4px)`,
      }
    : {
        left: `calc(${indent}px + 2px)`,
        width: `calc(100% - ${indent}px - 4px)`,
      };
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
        "event-card group absolute min-h-[13px] overflow-hidden rounded-lg shadow-sm ring-1 ring-border/60 inset-ring inset-ring-black/10 select-none dark:inset-ring-white/10",
        draggable ? "cursor-grab" : "cursor-pointer",
        isDragging &&
          "cursor-grabbing touch-none shadow-lg ring-2 ring-primary/60",
      )}
      style={{
        top: `${topPct}%`,
        height: `${heightPct}%`,
        left: horizontal.left,
        width: horizontal.width,
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
      {draggable && (
        <>
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
        </>
      )}
    </motion.div>
  );
}
