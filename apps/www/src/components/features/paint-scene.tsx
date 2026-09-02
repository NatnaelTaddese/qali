import { cn } from "@qali/ui/lib/utils";

import {
  BASE_EVENTS,
  formatTime,
  heightPct,
  topPct,
  useWeekDays,
  WEEK_DAYS,
  type TimeWindow,
} from "./lib";
import { CheckIcon, MiniEvent, MiniGrid } from "./parts";
import { useLoop } from "./use-loop";

/**
 * Availability painting: green spans drawn straight onto the week, using the
 * app's `AvailabilityBlock` recipe (chart-2 tint, hairline border, time label,
 * shimmer on save). The loop clears the week, paints it back span by span with
 * a brush dot riding the growing edge, then sweeps and saves.
 */
const STEPS = [2600, 700, 1300, 1300, 2400] as const;

const PAINT_WINDOW: TimeWindow = { start: 9 * 60, end: 17 * 60 };

interface PaintSpan {
  id: "mon" | "wed" | "fri";
  day: number;
  start: number;
  end: number;
}

const SPANS: PaintSpan[] = [
  { id: "mon", day: 0, start: 9 * 60, end: 12 * 60 },
  { id: "wed", day: 2, start: 13 * 60, end: 17 * 60 },
  { id: "fri", day: 4, start: 10 * 60, end: 12 * 60 },
];

/** The meetings that stay on the grid for context: everything that doesn't
 * collide with a span, since you aren't free during a meeting. */
const CONTEXT_EVENTS = BASE_EVENTS.filter(
  (e) => !["mon-design", "wed-focus", "fri-demo"].includes(e.id),
);

function grownAt(span: PaintSpan, step: number) {
  if (step === 1) return false;
  if (step === 2) return span.id === "mon";
  return true;
}

function brushAt(span: PaintSpan, step: number) {
  return (step === 2 && span.id === "mon") || (step === 3 && span.id === "wed");
}

const SWEEP_GRADIENT =
  "linear-gradient(100deg, transparent 30%, color-mix(in oklab, var(--chart-2) 40%, transparent) 50%, transparent 70%)";

export function PaintScene({ playing }: { playing: boolean }) {
  const { step } = useLoop(STEPS, playing);
  const { days, todayIndex } = useWeekDays();
  const saved = step === 4;

  return (
    <div className="flex w-full flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-chart-2/15 px-2.5 py-1 text-xs font-medium text-chart-2">
          <span className="size-1.5 rounded-full bg-chart-2" />
          Setting availability
        </span>
        <span
          key={saved ? "saved" : "idle"}
          className={cn(
            "inline-flex items-center gap-1 text-xs font-medium text-muted-foreground",
            saved ? "feature-pop-in" : "opacity-0",
          )}
        >
          <CheckIcon className="size-3.5" />
          Saved
        </span>
      </div>

      <MiniGrid
        win={PAINT_WINDOW}
        days={WEEK_DAYS}
        dates={days}
        todayIndex={todayIndex}
        className="h-64 sm:h-72"
      >
        {(dayIndex) => (
          <>
            {CONTEXT_EVENTS.filter((e) => e.day === dayIndex).map((event) => (
              <MiniEvent key={event.id} event={event} dim win={PAINT_WINDOW} />
            ))}
            {SPANS.filter((s) => s.day === dayIndex).map((span) => {
              const grown = grownAt(span, step);
              const brush = brushAt(span, step);
              return (
                <div key={span.id}>
                  <div
                    className="absolute inset-x-0.5 z-20 overflow-hidden rounded-md border border-chart-2/50 bg-chart-2/15 transition-[height,opacity] duration-500 ease-out motion-reduce:transition-none sm:inset-x-1"
                    style={{
                      top: `${topPct(span.start, PAINT_WINDOW)}%`,
                      height: grown
                        ? `${heightPct(span.start, span.end, PAINT_WINDOW)}%`
                        : "0%",
                      opacity: grown ? 1 : 0,
                    }}
                  >
                    {saved && (
                      <span
                        aria-hidden
                        className="feature-sweep pointer-events-none absolute inset-y-0 -inset-x-1"
                        style={{ background: SWEEP_GRADIENT }}
                      />
                    )}
                    <span className="relative block truncate px-1 py-0.5 text-[0.6rem] font-medium leading-tight text-chart-2 sm:text-[0.7rem]">
                      {formatTime(span.start)} – {formatTime(span.end)}
                    </span>
                  </div>
                  {/* The brush: rides the span's growing edge. */}
                  <span
                    aria-hidden
                    className="absolute left-1/2 z-30 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-card ring-2 ring-chart-2 transition-[top,opacity] duration-500 ease-out motion-reduce:transition-none"
                    style={{
                      top: `${topPct(grown ? span.end : span.start, PAINT_WINDOW)}%`,
                      opacity: brush ? 1 : 0,
                    }}
                  />
                </div>
              );
            })}
          </>
        )}
      </MiniGrid>
    </div>
  );
}
