import { cn } from "@qali/ui/lib/utils";
import type { ReactNode } from "react";

import {
  DEFAULT_WINDOW,
  formatRange,
  heightPct,
  hourLabel,
  hoursIn,
  topPct,
  WEEKDAY_LABELS,
  type GhostSlot,
  type PreviewEvent,
  type TimeWindow,
} from "./lib";

/**
 * A miniature time grid: optional day header, hour gutter, hour lines and one
 * column per day. Each column's contents come from `children(dayIndex)` so the
 * scenes decide what sits on the grid (event cards, painted spans, ghosts).
 */
export function MiniGrid({
  win = DEFAULT_WINDOW,
  days,
  dates,
  todayIndex = -1,
  className,
  children,
}: {
  win?: TimeWindow;
  days: readonly number[];
  /** Mon–Fri dates for the header. Omit to hide the header. */
  dates?: readonly Date[];
  todayIndex?: number;
  /** Height classes for the grid body. */
  className?: string;
  children: (dayIndex: number) => ReactNode;
}) {
  const hours = hoursIn(win);
  return (
    <div
      aria-hidden
      className="w-full overflow-hidden rounded-2xl bg-background ring-1 ring-border"
    >
      {dates && (
        <div className="flex border-b border-border/70">
          <div className="w-9 shrink-0 sm:w-11" aria-hidden />
          {days.map((dayIndex) => {
            const isToday = dayIndex === todayIndex;
            return (
              <div
                key={dayIndex}
                className="flex flex-1 items-center justify-center gap-1.5 py-2"
              >
                <span
                  className={cn(
                    "text-[0.65rem] font-medium sm:text-xs",
                    isToday ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {WEEKDAY_LABELS[dayIndex]}
                </span>
                <span
                  className={cn(
                    "text-[0.65rem] font-semibold sm:text-xs",
                    isToday
                      ? "flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                      : "text-foreground/70",
                  )}
                >
                  {dates[dayIndex]?.getDate()}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className={cn("relative flex", className)}>
        <div className="relative w-9 shrink-0 sm:w-11">
          {hours.slice(0, -1).map((hour) => (
            <span
              key={hour}
              className="absolute right-1.5 -translate-y-1/2 text-[0.55rem] tabular-nums text-muted-foreground/70 sm:text-[0.65rem]"
              style={{ top: `${topPct(hour * 60, win)}%` }}
            >
              {hourLabel(hour)}
            </span>
          ))}
        </div>

        <div className="relative flex flex-1">
          <div className="pointer-events-none absolute inset-0">
            {hours.map((hour) => (
              <div
                key={hour}
                className="absolute inset-x-0 border-t border-border/50"
                style={{ top: `${topPct(hour * 60, win)}%` }}
              />
            ))}
          </div>
          {days.map((dayIndex) => (
            <div
              key={dayIndex}
              className={cn(
                "relative flex-1 border-l border-border/50 first:border-l-0",
                dayIndex === todayIndex && "bg-primary/[0.03]",
              )}
            >
              {children(dayIndex)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A single event card, matching the app's `.event-card` treatment. Position,
 * size and visibility move through plain CSS transitions so a re-render always
 * carries the change and nothing is ever left invisible. */
export function MiniEvent({
  event,
  removed = false,
  dim = false,
  win = DEFAULT_WINDOW,
}: {
  event: PreviewEvent;
  removed?: boolean;
  /** Neutral, faded treatment for context events behind a scene's subject. */
  dim?: boolean;
  win?: TimeWindow;
}) {
  const color = dim ? "--event-neutral" : event.color;
  // A short card only has room for its title; the time line would clip.
  const showTime = event.end - event.start >= 60;
  return (
    <div
      className={cn(
        "absolute inset-x-0.5 z-10 min-h-[16px] overflow-hidden rounded-md shadow-sm ring-1 ring-border/60 inset-ring inset-ring-black/10 transition-[top,height,opacity,transform] duration-500 ease-out motion-reduce:transition-none sm:inset-x-1 sm:rounded-lg dark:inset-ring-white/10",
        dim && "opacity-60",
      )}
      style={{
        top: `${topPct(event.start, win)}%`,
        height: `${heightPct(event.start, event.end, win)}%`,
        opacity: removed ? 0 : undefined,
        transform: removed ? "scale(0.92)" : "scale(1)",
        backgroundColor: `color-mix(in oklab, var(${color}) 22%, var(--card))`,
      }}
    >
      <span
        aria-hidden
        className="absolute top-1 bottom-1 left-1 w-[3px] rounded-full"
        style={{ backgroundColor: `var(${color})` }}
      />
      <div className="flex h-full flex-col justify-start py-0.5 pr-1 pl-2.5 sm:py-1 sm:pr-1.5 sm:pl-3">
        <p className="truncate text-[0.6rem] font-medium leading-tight text-foreground sm:text-[0.7rem]">
          {event.title}
        </p>
        {showTime && (
          <p className="hidden truncate text-[0.6rem] leading-tight text-muted-foreground sm:block">
            {formatRange(event.start, event.end)}
          </p>
        )}
      </div>
    </div>
  );
}

/** The AI-suggested open slot. Pops in via `feature-pop-in` on mount. */
export function GhostCard({
  slot,
  win = DEFAULT_WINDOW,
}: {
  slot: GhostSlot;
  win?: TimeWindow;
}) {
  return (
    <div
      className="feature-pop-in absolute inset-x-0.5 z-20 flex min-h-[16px] flex-col justify-center gap-0.5 overflow-hidden rounded-md border-2 border-dashed border-primary/60 bg-primary/[0.08] px-1.5 text-left leading-none sm:inset-x-1 sm:rounded-lg"
      style={{
        top: `${topPct(slot.start, win)}%`,
        height: `${heightPct(slot.start, slot.end, win)}%`,
      }}
    >
      <span className="truncate text-[0.6rem] font-semibold text-primary sm:text-[0.7rem]">
        {slot.label}
      </span>
      {slot.end - slot.start >= 60 && (
        <span className="hidden truncate text-[0.6rem] text-primary/70 sm:block">
          {formatRange(slot.start, slot.end)}
        </span>
      )}
    </div>
  );
}

/** Compact monotone mascot glyph, echoing the assistant dock's `MascotGlyph`.
 * The eyes take `eye`, the colour of whatever surface the glyph sits on. */
export function MascotSpark({
  className,
  eye = "var(--primary)",
}: {
  className?: string;
  eye?: string;
}) {
  return (
    <svg
      viewBox="0 0 236 236"
      className={cn("size-5 shrink-0", className)}
      fill="none"
      role="presentation"
      focusable="false"
    >
      <path
        d="M40 118 C36 66 74 30 122 32 C172 34 202 74 196 122 C193 147 181 158 176 176 C171 195 176 214 156 216 C141 217 137 201 128 199 C119 197 113 208 101 209 C86 210 80 197 73 180 C67 165 51 158 45 141 C41 129 40 124 40 118 Z"
        fill="currentColor"
      />
      <rect x="80" y="88" width="28" height="54" rx="14" fill={eye} />
      <rect x="128" y="92" width="28" height="54" rx="14" fill={eye} />
    </svg>
  );
}

export function ThinkingDots() {
  return (
    <span className="inline-flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="feature-dot inline-block size-1 rounded-full bg-current"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={cn("size-4 shrink-0", className)}
      fill="none"
      aria-hidden
    >
      <path
        d="M5 10.5 8.5 14 15 6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Monochrome Google "G", for the account cards. */
export function GoogleMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("size-3 shrink-0", className)}
      fill="currentColor"
      aria-hidden
    >
      <path d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
      <path d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z" />
      <path d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z" />
      <path d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
    </svg>
  );
}
