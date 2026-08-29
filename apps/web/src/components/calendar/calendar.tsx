import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { api } from "@qali/backend/convex/_generated/api";
import type { Doc } from "@qali/backend/convex/_generated/dataModel";
import { Checkbox } from "@qali/ui/components/checkbox";
import { GooDropdown } from "@qali/ui/components/ui/goo-dropdown";
import { cn } from "@qali/ui/lib/utils";
import { useMutation } from "convex/react";
import { addDays, getISOWeek, isSameDay, isSameMonth, startOfDay } from "date-fns";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { CalendarPager, type CalendarPagerHandle } from "./calendar-pager";
import { calendarColorVar } from "./colors";
import {
  addPages,
  calendarDisplayName,
  type CalendarListItem,
  type CalendarView,
  dayKey,
  eventQueryRange,
  msToPct,
  pageDays,
  pageStart,
  STRIP_SIDE_DAYS,
  stripDays,
  VIEW_BUFFER,
  VIEW_COLUMNS,
  VIEW_NAV_DAYS,
  viewTitle,
} from "./lib";
import { MonthPanel } from "./month-panel";
import { MonthPicker } from "./month-picker";
import { TimeStrip, type TimeStripHandle } from "./time-strip";
import { NO_REVEAL, type Reveal } from "./today-pulse";
import { useStableQuery } from "./use-stable-query";
import { useDock } from "@/components/workspace/dock-context";
import { NotificationBell } from "@/components/workspace/notification-bell";
import { usePreferences } from "@/components/workspace/preferences-context";

const VIEWS: CalendarView[] = ["day", "week", "month"];
/** Stable empty fallback: a fresh `[]` each render would defeat the
 * memoization downstream in the strip. */
const NO_EVENTS: Doc<"events">[] = [];

export function CalendarWeekView() {
  const { weekStartsOn, defaultView } = usePreferences();
  const [view, setView] = useState<CalendarView>(defaultView);
  const [anchor, setAnchor] = useState(() =>
    pageStart(defaultView, new Date(), weekStartsOn),
  );
  const [reveal, setReveal] = useState<Reveal>(NO_REVEAL);
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
      return {
        mode: "month" as const,
        pageStarts,
        centerIndex: buffer,
      };
    }
    const columns = VIEW_COLUMNS[view];
    const navDays = VIEW_NAV_DAYS[view];
    const side = STRIP_SIDE_DAYS[view];
    return {
      mode: "strip" as const,
      columns,
      navDays,
      anchorIndex: side,
      days: stripDays(anchor, columns, side),
    };
  }, [view, anchor]);

  // The query window is quantized to a week/month boundary, so scrolling
  // within it reuses the same Convex subscription instead of refetching per
  // day. `useStableQuery` holds the previous result across the boundary
  // crossings that do change it, and because each window fully contains the
  // strips reachable from it, that stale result is never missing a visible
  // day — the grid never blanks. `bucketDayEvents`/`MonthPanel` filter the
  // extra events down to the rendered days.
  const queryRange = useMemo(
    () => eventQueryRange(view, anchor, weekStartsOn),
    [view, anchor, weekStartsOn],
  );
  const events =
    useStableQuery(api.domains.calendar.queries.listEventsInRange, queryRange) ?? NO_EVENTS;

  const calendars = useStableQuery(api.domains.calendar.queries.listCalendars) ?? [];

  // Tell the dock which day its Create button should seed a new event on: today
  // when the current page shows it, otherwise the page's own start. The dock
  // reads this plus the events below to land on the next free slot.
  const { registerCreateSeed, registerReveal } = useDock();
  const focusDayMs = useMemo(() => {
    const today = startOfDay(new Date());
    const onPage = pageDays(view, anchor, weekStartsOn).some((day) =>
      isSameDay(day, today),
    );
    return (onPage ? today : startOfDay(anchor)).getTime();
  }, [view, anchor, weekStartsOn]);
  useEffect(() => {
    registerCreateSeed({ dayStartMs: focusDayMs, events });
    return () => registerCreateSeed(null);
  }, [registerCreateSeed, focusDayMs, events]);

  // Prev/next: step one page (month) or the configured day count, animating the scroll.
  const step = (dir: number) => {
    if (layout.mode === "month") {
      pagerRef.current?.scrollToIndex(layout.centerIndex + dir, "smooth");
    } else {
      stripRef.current?.scrollToIndex(
        layout.anchorIndex + dir * layout.navDays,
        "smooth",
      );
    }
  };

  // Jump to the page/day containing `date`.
  const jumpTo = useCallback(
    (date: Date) => {
      setAnchor(pageStart(view, date, weekStartsOn));
    },
    [view, weekStartsOn],
  );

  // A week-start change re-cuts the visible page: the anchor was computed
  // under the old week shape, so re-normalize it (a no-op for day/month).
  // Deliberately keyed on the preference alone — `view` is read for
  // normalization only, and re-running on view changes would fight
  // switchView's own anchor updates.
  useEffect(() => {
    setAnchor((current) => pageStart(view, current, weekStartsOn));
  }, [weekStartsOn]);

  // Settle handlers must keep a stable identity across renders: the scrollers
  // derive their recentering effect's dependencies from them, so an inline
  // arrow here re-fires that effect on every render and yanks the scroll
  // position mid-gesture. The functional updates make `[]` deps correct.
  const handleSettleDeltaDays = useCallback(
    (delta: number) => setAnchor((a) => addDays(a, delta)),
    [],
  );
  const handleSettleDeltaPages = useCallback(
    (delta: number) => setAnchor((a) => addPages("month", a, delta)),
    [],
  );

  // Animate calendar-body changes via the View Transitions API. `name` selects a
  // [data-cal-transition] variant: "zoom" (scale crossfade) for month-overview
  // changes, "width" for week↔day, "slide-fwd"/"slide-back" for a directional
  // Today jump. `flushSync` commits the new tree (and its layout effects)
  // synchronously so the browser snapshots the settled view. Falls back to a
  // plain swap when reduced-motion is on or View Transitions are unsupported
  // (Firefox / older Safari).
  const runTransition = useCallback(
    (name: string, apply: () => void, onFinished?: () => void) => {
      const el = document.documentElement;
      if (reduce || typeof document.startViewTransition !== "function") {
        if (onFinished) {
          flushSync(apply);
          onFinished();
        } else {
          apply();
        }
        return;
      }
      el.dataset.calTransition = name;
      const transition = document.startViewTransition(() => {
        flushSync(apply);
      });
      transition.finished.finally(() => {
        delete el.dataset.calTransition;
        onFinished?.();
      });
    },
    [reduce],
  );

  // Move a target day/time to center, then pulse the item there. When the day is
  // already in the buffered window we scroll to it for real (continuous, through
  // the actual days); otherwise the days between aren't rendered, so we rebuild
  // centered on it under a directional slide transition. Day/week center the day
  // among the visible columns and ease vertically to `vertical` (a pct of the
  // day, "now" for the current-time line, or null to keep the position); month
  // shows the whole month. `flashId` is the reveal key of the item to pulse.
  // Bump the reveal so the matching item pulses; `at` lets a late-mounting card
  // (an assistant change still syncing back) know the reveal is fresh.
  const bumpReveal = (flashId: string) =>
    setReveal((prev) => ({ id: flashId, nonce: prev.nonce + 1, at: Date.now() }));

  const revealTarget = (spec: {
    date: Date;
    vertical: number | "now" | null;
    flashId: string;
  }) => {
    const flash = () => bumpReveal(spec.flashId);
    const scrollColumn = (index: number) => {
      if (spec.vertical === "now") {
        stripRef.current?.scrollToTodayColumn(index, flash);
      } else {
        stripRef.current?.scrollToColumn(index, spec.vertical, flash);
      }
    };

    if (layout.mode === "strip") {
      const centerOffset = Math.floor(layout.columns / 2);
      const dayIndex = layout.days.findIndex((d) => isSameDay(d, spec.date));
      const targetIndex = dayIndex - centerOffset;
      const maxIndex = layout.days.length - layout.columns;
      // On-strip and fully scrollable to a centered position: real scroll.
      if (dayIndex !== -1 && targetIndex >= 0 && targetIndex <= maxIndex) {
        scrollColumn(targetIndex);
        return;
      }
      const target = addDays(startOfDay(spec.date), -centerOffset);
      const dir = Math.sign(target.getTime() - anchor.getTime());
      // Anchor can't move (the target sits at a short-buffer edge): scroll as
      // far toward centered as the strip allows rather than rebuilding to the
      // same place.
      if (dir === 0) {
        scrollColumn(Math.max(0, Math.min(targetIndex, maxIndex)));
        return;
      }
      if (spec.vertical === "now") stripRef.current?.primeCenterNow();
      else stripRef.current?.primeCenterAt(spec.vertical);
      runTransition(
        dir > 0 ? "slide-fwd" : "slide-back",
        () => setAnchor(target),
        flash,
      );
      return;
    }

    // Month.
    const monthIndex = layout.pageStarts.findIndex((s) =>
      isSameMonth(s, spec.date),
    );
    if (monthIndex !== -1) {
      pagerRef.current?.scrollToIndex(monthIndex, "smooth", flash);
      return;
    }
    const target = pageStart("month", spec.date);
    const dir = Math.sign(target.getTime() - anchor.getTime());
    if (dir === 0) {
      flash();
      return;
    }
    runTransition(
      dir > 0 ? "slide-fwd" : "slide-back",
      () => setAnchor(target),
      flash,
    );
  };

  // Today is just a reveal of today's date pill at the current-time line.
  const goToToday = () =>
    revealTarget({
      date: new Date(),
      vertical: "now",
      flashId: dayKey(new Date()),
    });

  // The panels reach for an item by its start time and reveal key. In month
  // view there is no time position, so we flash the whole day cell (keyed by
  // day) instead of the item. Without a start time we can only pulse an item
  // that is already on screen.
  const revealItem = (input: { startMs?: number; flashId: string }) => {
    if (input.startMs == null) {
      bumpReveal(input.flashId);
      return;
    }
    const date = new Date(input.startMs);
    if (layout.mode === "month") {
      revealTarget({ date, vertical: null, flashId: dayKey(date) });
    } else {
      revealTarget({
        date,
        vertical: msToPct(input.startMs, startOfDay(date).getTime()),
        flashId: input.flashId,
      });
    }
  };

  // Register with the dock through a ref so a single stable callback always runs
  // the latest closure (which reads the current view/anchor), the way the create
  // seed is registered — without re-registering on every scroll settle.
  const revealItemRef = useRef(revealItem);
  revealItemRef.current = revealItem;
  useEffect(() => {
    registerReveal((input) => revealItemRef.current(input));
    return () => registerReveal(null);
  }, [registerReveal]);

  const switchView = (next: CalendarView) => {
    const apply = () => {
      setAnchor(pageStart(next, anchor, weekStartsOn));
      setView(next);
    };
    const granularityDelta = VIEWS.indexOf(next) - VIEWS.indexOf(view);
    if (granularityDelta === 0) {
      apply();
      return;
    }
    const isWeekDay =
      (view === "week" && next === "day") ||
      (view === "day" && next === "week");
    const style = isWeekDay ? "width" : "zoom";
    const direction = granularityDelta > 0 ? "out" : "in";
    runTransition(`${style}-${direction}`, apply);
  };

  const openDay = (day: Date) => {
    runTransition("zoom-in", () => {
      setAnchor(pageStart("day", day));
      setView("day");
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        data-dock-keep-open
        className="flex items-center justify-between gap-4 border-t border-border/80 bg-calendar-header px-4 py-2.5"
      >
        <div className="flex items-center justify-center gap-2 text-sm">
          <MonthPicker
            selectedWeekStart={pageStart("week", anchor, weekStartsOn)}
            onSelect={jumpTo}
          >
            <span className="font-medium">{viewTitle(view, anchor)}</span>
            {view === "week" && (
              <span className="flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                W{getISOWeek(anchor)}
                <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-3" />
              </span>
            )}
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
              onClick={goToToday}
              className="rounded-md px-2.5 py-1 text-sm font-medium hover:bg-accent"
            >
              Today
            </button>
            <NavArrow icon={ArrowLeft01Icon} label="Previous" onClick={() => step(-1)} />
            <NavArrow icon={ArrowRight01Icon} label="Next" onClick={() => step(1)} />
          </div>

          <CalendarPicker calendars={calendars} />

          <NotificationBell />
        </div>
      </header>

      <div className="calendar-body-vt flex min-h-0 flex-1 flex-col">
        {layout.mode === "month" ? (
          <CalendarPager
            ref={pagerRef}
            pageStarts={layout.pageStarts}
            centerIndex={layout.centerIndex}
            gutterWidth={0}
            onSettleDelta={handleSettleDeltaPages}
            renderPage={(start) => (
              <MonthPanel
                monthStart={start}
                days={pageDays("month", start, weekStartsOn)}
                events={events}
                onSelectDay={openDay}
                reveal={reveal}
              />
            )}
          />
        ) : (
          <TimeStrip
            ref={stripRef}
            days={layout.days}
            anchorIndex={layout.anchorIndex}
            columns={layout.columns}
            events={events}
            onSettleDeltaDays={handleSettleDeltaDays}
            reveal={reveal}
          />
        )}
      </div>
    </div>
  );
}

function CalendarPicker({ calendars }: { calendars: CalendarListItem[] }) {
  const setSelected = useMutation(api.domains.calendar.mutations.setCalendarSelected);
  const selectedCount = calendars.filter((c) => c.selected).length;
  // Primary first, then alphabetical by display name.
  const sorted = [...calendars].sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return calendarDisplayName(a).localeCompare(calendarDisplayName(b));
  });

  return (
    <GooDropdown
      trigger={
        <>
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
          <span className="text-sm">
            {calendars.length === 0
              ? "No calendars"
              : `${selectedCount} of ${calendars.length} calendar${
                  calendars.length === 1 ? "" : "s"
                }`}
          </span>
        </>
      }
      triggerLabel="Choose calendars"
      menuLabel="Calendars"
      panelContent={
        <div className="flex h-full flex-col">
          <p className="flex h-7 shrink-0 items-center px-1 text-xs font-medium opacity-70">
            Calendars
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
            {sorted.map((cal, index) => (
              <label
                key={cal._id}
                className="flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 transition-colors hover:bg-[var(--goo-hover-fill)]"
              >
                <Checkbox
                  autoFocus={index === 0}
                  className="size-5 rounded-md border-primary-foreground/40 bg-primary-foreground/10 transition-colors focus-visible:border-primary-foreground focus-visible:ring-primary-foreground/30 data-checked:border-primary-foreground data-checked:bg-primary-foreground data-checked:text-primary dark:data-checked:bg-primary-foreground"
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
        </div>
      }
      contentHeight={28 + Math.min(sorted.length, 8) * 32}
      triggerSound={false}
      align="end"
      side="bottom"
      gap={4}
      width={256}
      buttonRadius={10}
      panelRadius={18}
      fill="transparent"
      foreground="var(--muted-foreground)"
      hoverFill="var(--accent)"
      activeFill="var(--primary)"
      activeForeground="var(--primary-foreground)"
      activeHoverFill="color-mix(in oklch, var(--primary-foreground) 14%, var(--primary))"
      triggerClassName="gap-2 !px-1 rounded-lg hover:bg-accent"
    />
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
