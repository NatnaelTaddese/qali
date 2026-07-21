import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Doc } from "@qali/backend/convex/_generated/dataModel";
import { Checkbox } from "@qali/ui/components/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@qali/ui/components/popover";
import { cn } from "@qali/ui/lib/utils";
import { useMutation } from "convex/react";
import { addDays, getISOWeek } from "date-fns";
import { useReducedMotion } from "motion/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { CalendarPager, type CalendarPagerHandle } from "./calendar-pager";
import { calendarColorVar } from "./colors";
import {
  addPages,
  calendarDisplayName,
  type CalendarView,
  MS_PER_DAY,
  pageDays,
  pageStart,
  STRIP_SIDE_DAYS,
  stripDays,
  VIEW_BUFFER,
  VIEW_COLUMNS,
  VIEW_SNAP_DAYS,
  viewTitle,
} from "./lib";
import { MonthPanel } from "./month-panel";
import { MonthPicker } from "./month-picker";
import { TimeStrip, type TimeStripHandle } from "./time-strip";
import { useStableQuery } from "./use-stable-query";

const VIEWS: CalendarView[] = ["day", "week", "month"];

export function CalendarWeekView() {
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => pageStart("week", new Date()));
  const pagerRef = useRef<CalendarPagerHandle>(null);
  const stripRef = useRef<TimeStripHandle>(null);
  const reduce = useReducedMotion();

  // Month pages by whole months; day/week slide a continuous day strip.
  const layout = useMemo(() => {
    if (view === "month") {
      const buffer = VIEW_BUFFER.month;
      const pageStarts = Array.from({ length: 2 * buffer + 1 }, (_, i) =>
        addPages("month", anchor, i - buffer),
      );
      const firstDays = pageDays("month", pageStarts[0]);
      const lastDays = pageDays("month", pageStarts[pageStarts.length - 1]);
      return {
        mode: "month" as const,
        pageStarts,
        centerIndex: buffer,
        rangeStartMs: firstDays[0].getTime(),
        rangeEndMs: lastDays[lastDays.length - 1].getTime() + MS_PER_DAY,
      };
    }
    const columns = VIEW_COLUMNS[view];
    const snapDays = VIEW_SNAP_DAYS[view];
    const side = STRIP_SIDE_DAYS[view];
    const days = stripDays(anchor, columns, side);
    return {
      mode: "strip" as const,
      columns,
      snapDays,
      anchorIndex: side,
      days,
      rangeStartMs: days[0].getTime(),
      rangeEndMs: days[days.length - 1].getTime() + MS_PER_DAY,
    };
  }, [view, anchor]);

  const events =
    useStableQuery(api.calendar.listEventsInRange, {
      startMs: layout.rangeStartMs,
      endMs: layout.rangeEndMs,
    }) ?? [];

  const calendars = useStableQuery(api.calendar.listCalendars) ?? [];
  // Prev/next: step one page (month) or one snap (day/week), animating the scroll.
  const step = (dir: number) => {
    if (layout.mode === "month") {
      pagerRef.current?.scrollToIndex(layout.centerIndex + dir, "smooth");
    } else {
      stripRef.current?.scrollToIndex(
        layout.anchorIndex + dir * layout.snapDays,
        "smooth",
      );
    }
  };

  // Jump to the page/day containing `date`.
  const jumpTo = useCallback(
    (date: Date) => {
      setAnchor(pageStart(view, date));
    },
    [view],
  );

  // Zoom between month and week/day via the View Transitions API. `flushSync`
  // commits the new tree (and its layout effects) synchronously so the browser
  // snapshots the settled view. Falls back to a plain swap when reduced-motion
  // is on or the browser lacks View Transitions (Firefox / older Safari).
  const runZoom = useCallback(
    (direction: "in" | "out", apply: () => void) => {
      const el = document.documentElement;
      if (reduce || typeof document.startViewTransition !== "function") {
        apply();
        return;
      }
      el.dataset.calZoom = direction;
      const transition = document.startViewTransition(() => {
        flushSync(apply);
      });
      transition.finished.finally(() => {
        delete el.dataset.calZoom;
      });
    },
    [reduce],
  );

  const switchView = (next: CalendarView) => {
    const apply = () => {
      setAnchor(pageStart(next, anchor));
      setView(next);
    };
    // Zoom out into the month overview, zoom in leaving it; day <-> week stays
    // in strip mode (no subtree swap) so it swaps instantly.
    if (next === "month" && view !== "month") runZoom("out", apply);
    else if (view === "month" && next !== "month") runZoom("in", apply);
    else apply();
  };

  const openDay = (day: Date) => {
    runZoom("in", () => {
      setAnchor(pageStart("day", day));
      setView("day");
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-4 border-t border-border/80 bg-calendar-header px-4 py-2.5">
        <div className="flex items-center justify-center gap-2 text-sm">
          <span className="text-muted-foreground">View</span>
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={2}
            className="size-4 text-muted-foreground/60"
          />
          <MonthPicker selectedWeekStart={pageStart("week", anchor)} onSelect={jumpTo}>
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-1 py-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="font-medium">{viewTitle(view, anchor)}</span>
              {view === "week" && (
                <span className="flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                  W{getISOWeek(anchor)}
                  <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-3" />
                </span>
              )}
            </button>
          </MonthPicker>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-lg bg-secondary p-0.5 text-sm">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => switchView(v)}
                className={cn(
                  "rounded-md px-2.5 py-1 font-medium capitalize transition-colors",
                  v === view
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => jumpTo(new Date())}
              className="rounded-md px-2.5 py-1 text-sm font-medium hover:bg-accent"
            >
              Today
            </button>
            <NavArrow icon={ArrowLeft01Icon} label="Previous" onClick={() => step(-1)} />
            <NavArrow icon={ArrowRight01Icon} label="Next" onClick={() => step(1)} />
          </div>

          <CalendarPicker calendars={calendars} />

        </div>
      </header>

      <div className="calendar-body-vt flex min-h-0 flex-1 flex-col">
        {layout.mode === "month" ? (
          <CalendarPager
            ref={pagerRef}
            pageStarts={layout.pageStarts}
            centerIndex={layout.centerIndex}
            gutterWidth={0}
            onSettleDelta={(delta) => setAnchor((a) => addPages("month", a, delta))}
            renderPage={(start) => (
              <MonthPanel
                monthStart={start}
                days={pageDays("month", start)}
                events={events}
                onSelectDay={openDay}
              />
            )}
          />
        ) : (
          <TimeStrip
            ref={stripRef}
            days={layout.days}
            anchorIndex={layout.anchorIndex}
            columns={layout.columns}
            snapDays={layout.snapDays}
            events={events}
            onSettleDeltaDays={(delta) => setAnchor((a) => addDays(a, delta))}
          />
        )}
      </div>
    </div>
  );
}

function CalendarPicker({ calendars }: { calendars: Doc<"calendars">[] }) {
  const setSelected = useMutation(api.calendar.setCalendarSelected);
  const selectedCount = calendars.filter((c) => c.selected).length;
  // Primary first, then alphabetical by display name.
  const sorted = [...calendars].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return calendarDisplayName(a).localeCompare(calendarDisplayName(b));
  });

  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center gap-2 rounded-md px-1 py-0.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Choose calendars"
      >
        <div className="flex items-center -space-x-1.5">
          {sorted
            .filter((c) => c.selected)
            .slice(0, 8)
            .map((c) => (
              <span
                key={c._id}
                className="size-4 rounded-full ring-2 ring-background"
                style={{
                  backgroundColor: `var(${calendarColorVar(c)})`,
                }}
              />
            ))}
        </div>
        <span className="text-sm text-muted-foreground">
          {calendars.length === 0
            ? "No calendars"
            : `${selectedCount} of ${calendars.length} calendar${
                calendars.length === 1 ? "" : "s"
              }`}
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-64">
        <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">
          Calendars
        </p>
        <div className="flex flex-col gap-0.5">
          {sorted.map((cal) => (
            <label
              key={cal._id}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-accent"
            >
              <Checkbox
                checked={cal.selected}
                onCheckedChange={(checked) =>
                  void setSelected({
                    calendarId: cal._id,
                    selected: checked === true,
                  })
                }
              />
              <span
                className="size-3 shrink-0 rounded-full"
                style={{
                  backgroundColor: `var(${calendarColorVar(cal)})`,
                }}
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                {calendarDisplayName(cal)}
              </span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NavArrow({
  icon,
  label,
  onClick,
}: {
  icon: typeof ArrowLeft01Icon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4" />
    </button>
  );
}
