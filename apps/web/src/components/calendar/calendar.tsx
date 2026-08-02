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
  VIEW_NAV_DAYS,
  viewTitle,
} from "./lib";
import { MonthPanel } from "./month-panel";
import { MonthPicker } from "./month-picker";
import { TimeStrip, type TimeStripHandle } from "./time-strip";
import { useStableQuery } from "./use-stable-query";
import { NotificationBell } from "@/components/workspace/notification-bell";

const VIEWS: CalendarView[] = ["day", "week", "month"];

export function CalendarWeekView() {
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => pageStart("week", new Date()));
  const [pulseToken, setPulseToken] = useState(0);
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
    const navDays = VIEW_NAV_DAYS[view];
    const side = STRIP_SIDE_DAYS[view];
    const days = stripDays(anchor, columns, side);
    return {
      mode: "strip" as const,
      columns,
      navDays,
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
      setAnchor(pageStart(view, date));
    },
    [view],
  );

  // Animate calendar-body changes via the View Transitions API. `name` selects a
  // [data-cal-transition] variant: "zoom" (scale crossfade) for month-overview
  // changes, "width" for week↔day, "slide-fwd"/"slide-back" for a directional
  // Today jump. `flushSync` commits the new tree (and its layout effects)
  // synchronously so the browser snapshots the settled view. Falls back to a
  // plain swap when reduced-motion is on or View Transitions are unsupported
  // (Firefox / older Safari).
  const runTransition = useCallback(
    (name: string, apply: () => void) => {
      const el = document.documentElement;
      if (reduce || typeof document.startViewTransition !== "function") {
        apply();
        return;
      }
      el.dataset.calTransition = name;
      const transition = document.startViewTransition(() => {
        flushSync(apply);
      });
      transition.finished.finally(() => {
        delete el.dataset.calTransition;
      });
    },
    [reduce],
  );

  // Today: pulse today's marker and move it to center. When today is already in
  // the buffered window we scroll to it for real (continuous, through the actual
  // days); otherwise the days between aren't rendered, so we rebuild centered on
  // today under a directional slide transition. Day/week center today among the
  // visible columns; month shows today's whole month.
  const goToToday = () => {
    const today = new Date();
    setPulseToken((t) => t + 1);

    if (layout.mode === "strip") {
      const centerOffset = Math.floor(layout.columns / 2);
      const todayIndex = layout.days.findIndex((d) => isSameDay(d, today));
      const targetIndex = todayIndex - centerOffset;
      // On-strip and fully scrollable to a centered position: real scroll.
      if (
        todayIndex !== -1 &&
        targetIndex >= 0 &&
        targetIndex <= layout.days.length - layout.columns
      ) {
        stripRef.current?.scrollToTodayColumn(targetIndex);
        return;
      }
      const target = addDays(startOfDay(today), -centerOffset);
      const dir = Math.sign(target.getTime() - anchor.getTime());
      if (dir === 0) return;
      stripRef.current?.primeCenterNow();
      runTransition(dir > 0 ? "slide-fwd" : "slide-back", () =>
        setAnchor(target),
      );
      return;
    }

    // Month.
    const todayMonthIndex = layout.pageStarts.findIndex((s) =>
      isSameMonth(s, today),
    );
    if (todayMonthIndex !== -1) {
      pagerRef.current?.scrollToIndex(todayMonthIndex, "smooth");
      return;
    }
    const target = pageStart("month", today);
    const dir = Math.sign(target.getTime() - anchor.getTime());
    if (dir === 0) return;
    runTransition(dir > 0 ? "slide-fwd" : "slide-back", () => setAnchor(target));
  };

  const switchView = (next: CalendarView) => {
    const apply = () => {
      setAnchor(pageStart(next, anchor));
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
      <header className="flex items-center justify-between gap-4 border-t border-border/80 bg-calendar-header px-4 py-2.5">
        <div className="flex items-center justify-center gap-2 text-sm">
          <MonthPicker selectedWeekStart={pageStart("week", anchor)} onSelect={jumpTo}>
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
            onSettleDelta={(delta) => setAnchor((a) => addPages("month", a, delta))}
            renderPage={(start) => (
              <MonthPanel
                monthStart={start}
                days={pageDays("month", start)}
                events={events}
                onSelectDay={openDay}
                pulseToken={pulseToken}
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
            onSettleDeltaDays={(delta) => setAnchor((a) => addDays(a, delta))}
            pulseToken={pulseToken}
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
