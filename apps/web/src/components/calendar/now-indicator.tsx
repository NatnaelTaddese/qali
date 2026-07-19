import { isSameDay, startOfDay } from "date-fns";

import { msToPct } from "./lib";

export interface NowIndicatorLayout {
  /** Vertical position within the 24-hour body. */
  topPct: number;
  /** Today's column within the full buffered strip, when it is in view. */
  today: {
    /** Today's left edge within the full strip. */
    leftPct: number;
    /** One column's width within the full strip. */
    widthPct: number;
  } | null;
}

/** Indicator geometry: a full-width line at the current time, plus today's
 * column when it falls inside the buffered strip. */
export function getNowIndicatorLayout(
  days: Date[],
  now: number,
): NowIndicatorLayout | null {
  if (days.length === 0) return null;

  const todayIndex = days.findIndex((day) => isSameDay(day, now));

  return {
    topPct: msToPct(now, startOfDay(now).getTime()),
    today:
      todayIndex === -1
        ? null
        : {
            leftPct: (todayIndex / days.length) * 100,
            widthPct: (1 / days.length) * 100,
          },
  };
}

/** Stateless current-time line: faint across the whole strip, bright over
 * today's column when it is in view. */
export function NowIndicator({ layout }: { layout: NowIndicatorLayout }) {
  return (
    <div
      data-now-indicator
      className="pointer-events-none absolute inset-x-0 z-50"
      style={{ top: `${layout.topPct}%` }}
    >
      <div className="absolute inset-x-0 h-px -translate-y-1/2 bg-red-500/25" />
      {layout.today && (
        <div
          className="absolute h-px -translate-y-1/2 bg-red-500"
          style={{
            left: `${layout.today.leftPct}%`,
            width: `${layout.today.widthPct}%`,
          }}
        >
          <div className="absolute left-0 top-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500" />
        </div>
      )}
    </div>
  );
}
