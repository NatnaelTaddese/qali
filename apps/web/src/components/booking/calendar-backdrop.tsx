/**
 * The faint calendar time-grid that sits behind qali's account-less surfaces —
 * the login card and the public booking page — so both preview the calendar
 * they lead into. Extracted from the login screen so there is one copy.
 *
 * The grid is two `linear-gradient` line sets (hour rows + day columns) in the
 * calendar's own border colour, faded toward the edges with a radial mask. A
 * handful of `--event-*` ghost cards reuse the real event-card recipe (tinted
 * fill + left accent pill) at reduced opacity, and only show from `sm` up — on a
 * phone the card fills the width and there's no room beside it.
 */

/** Grid cell size — the vertical day lines are anchored to screen centre
 * (`50vw`), so a card centred on screen lands between two of them. */
const COL = 200; // px, one "day" column
const ROW = 64; // px, one "hour" row
const CELL_GAP = 4; // px inset so a ghost sits inside its cell, not on the lines

/** Faint sample events snapped to the grid. `col` is the column offset from
 * screen centre (negative = left), `row` is the row from the top; spans are
 * cell counts. */
const GHOST_EVENTS: {
  hue: string;
  title: string;
  time: string;
  col: number;
  colSpan: number;
  row: number;
  rowSpan: number;
}[] = [
  { hue: "--event-4", title: "Standup", time: "9:00 – 9:15 AM", col: -3, colSpan: 1, row: 1, rowSpan: 1 },
  { hue: "--event-6", title: "Deep work", time: "10:00 – 12:00 PM", col: -4, colSpan: 1, row: 5, rowSpan: 2 },
  { hue: "--event-5", title: "1:1", time: "4:00 – 4:30 PM", col: -3, colSpan: 1, row: 10, rowSpan: 1 },
  { hue: "--event-8", title: "Lunch", time: "12:30 – 1:30 PM", col: 3, colSpan: 1, row: 2, rowSpan: 1 },
  { hue: "--event-2", title: "Design review", time: "2:00 – 3:00 PM", col: 3, colSpan: 1, row: 7, rowSpan: 2 },
];

function GhostEvent({
  hue,
  title,
  time,
  col,
  colSpan,
  row,
  rowSpan,
}: (typeof GHOST_EVENTS)[number]) {
  return (
    <div
      className="absolute hidden overflow-hidden rounded-lg opacity-55 shadow-sm ring-1 ring-border/60 inset-ring inset-ring-black/10 sm:block dark:inset-ring-white/10"
      style={{
        left: `calc(50vw + ${col * COL + CELL_GAP}px)`,
        top: row * ROW + CELL_GAP,
        width: colSpan * COL - 2 * CELL_GAP,
        height: rowSpan * ROW - 2 * CELL_GAP,
        backgroundColor: `color-mix(in oklab, var(${hue}) 22%, var(--card))`,
      }}
    >
      <span
        className="absolute top-1 bottom-1 left-1 w-[3px] rounded-full"
        style={{ backgroundColor: `var(${hue})` }}
      />
      <div className="flex h-full flex-col justify-start py-1 pr-2 pl-3">
        <p className="text-sm font-medium leading-tight">{title}</p>
        <p className="truncate text-xs leading-tight text-muted-foreground">
          {time}
        </p>
      </div>
    </div>
  );
}

/** Full-bleed, non-interactive backdrop. Render as the first child of a
 * `relative overflow-hidden` container; the content sits above it at `z-10`.
 *
 * `ghosts` overlays the faint sample events; the login screen wants them, the
 * booking page keeps just the bare grid. */
export function CalendarBackdrop({ ghosts = true }: { ghosts?: boolean }) {
  return (
    <>
      {/* Calendar time grid: horizontal hour lines + vertical day dividers,
          matching the real calendar's line colour, fading toward the edges. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(to bottom, color-mix(in oklab, var(--border) 55%, transparent) 0 1px, transparent 1px)," +
            "linear-gradient(to right, color-mix(in oklab, var(--border) 55%, transparent) 0 1px, transparent 1px)",
          backgroundSize: `100% ${ROW}px, ${COL}px 100%`,
          // Hour lines run from the top; day lines are anchored to screen centre
          // so a card centred on screen lands on the grid.
          backgroundPosition: "0 0, 50vw 0",
          maskImage:
            "radial-gradient(120% 100% at 50% 45%, black 35%, transparent 92%)",
          WebkitMaskImage:
            "radial-gradient(120% 100% at 50% 45%, black 35%, transparent 92%)",
        }}
      />
      {/* Faint sample events sitting on the grid. */}
      {ghosts && (
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {GHOST_EVENTS.map((ghost) => (
            <GhostEvent key={ghost.title} {...ghost} />
          ))}
        </div>
      )}
    </>
  );
}
