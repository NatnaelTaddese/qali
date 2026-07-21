import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DayColumn } from "./day-column";
import { GutterColumn } from "./gutter-column";
import {
  bucketDayEvents,
  dayColsTemplate,
  GUTTER_TOTAL,
  MIN_DAY_HEIGHT,
  MS_PER_MINUTE,
  type CalendarEvent,
} from "./lib";
import { getNowIndicatorLayout, NowIndicator } from "./now-indicator";
import { PanelHeader } from "./panel-header";
import { useEventDrag } from "./use-event-drag";

export interface TimeStripHandle {
  /** Scroll to a day column index. Use "smooth" for button nav. */
  scrollToIndex: (index: number, behavior: ScrollBehavior) => void;
}

interface TimeStripProps {
  /** All buffered day columns; the anchor sits at `anchorIndex`. */
  days: Date[];
  /** Index of the leftmost visible (anchor) day within `days`. */
  anchorIndex: number;
  /** Visible columns (1 for day view, 7 for week). */
  columns: number;
  /** Horizontal scroll step, in days (1 for day view, 3 for week). */
  snapDays: number;
  /** Events for the whole strip range; bucketed per day internally. */
  events: CalendarEvent[];
  allDayHeight: number;
  /** Fired once scrolling settles `deltaDays` away from the anchor. */
  onSettleDeltaDays: (deltaDays: number) => void;
}

/**
 * A continuous horizontal strip of day columns with a pinned time gutter.
 * Scrolling snaps every `snapDays` columns, so the visible window slides in
 * multi-day steps rather than jumping a whole page. On settle it reports how
 * many days moved; the parent re-anchors and the strip silently recenters.
 *
 * Column width is expressed purely in CSS (no measured state / ResizeObserver);
 * JS reads `clientWidth` only on demand to translate a day index into a scroll
 * offset.
 */
export const TimeStrip = forwardRef<TimeStripHandle, TimeStripProps>(
  function TimeStrip(
    { days, anchorIndex, columns, snapDays, events, allDayHeight, onSettleDeltaDays },
    ref,
  ) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const suppressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const suppress = useRef(false);
    const didInitialNowScroll = useRef(false);
    const [now, setNow] = useState(() => Date.now());

    // Keep the clock aligned to minute boundaries, and recover immediately
    // when background-tab throttling or system sleep makes a timer stale.
    useEffect(() => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let interval: ReturnType<typeof setInterval> | undefined;

      const clearTimers = () => {
        if (timeout) clearTimeout(timeout);
        if (interval) clearInterval(interval);
      };
      const tick = () => setNow(Date.now());
      const schedule = () => {
        clearTimers();
        timeout = setTimeout(
          () => {
            tick();
            interval = setInterval(tick, MS_PER_MINUTE);
          },
          MS_PER_MINUTE - (Date.now() % MS_PER_MINUTE),
        );
      };
      const refresh = () => {
        tick();
        schedule();
      };
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") refresh();
      };

      schedule();
      window.addEventListener("focus", refresh);
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        clearTimers();
        window.removeEventListener("focus", refresh);
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }, []);

    const colWidth = useCallback(() => {
      const el = scrollerRef.current;
      if (!el) return 1;
      return Math.max((el.clientWidth - GUTTER_TOTAL) / columns, 1);
    }, [columns]);

    const scrollToIndex = useCallback(
      (index: number, behavior: ScrollBehavior) => {
        const el = scrollerRef.current;
        if (!el) return;
        if (behavior === "auto") {
          suppress.current = true;
          clearTimeout(suppressTimer.current);
          suppressTimer.current = setTimeout(() => {
            suppress.current = false;
          }, 80);
        }
        el.scrollTo({ left: index * colWidth(), behavior });
      },
      [colWidth],
    );

    useImperativeHandle(ref, () => ({ scrollToIndex }), [scrollToIndex]);

    // Recenter instantly when the strip rebuilds (anchor/view change) or mounts.
    useLayoutEffect(() => {
      scrollToIndex(anchorIndex, "auto");
    }, [days, anchorIndex, scrollToIndex]);

    // Keep the anchor centered across viewport resizes.
    useEffect(() => {
      const onResize = () => scrollToIndex(anchorIndex, "auto");
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [anchorIndex, scrollToIndex]);

    const onScroll = () => {
      if (suppress.current) return;
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        const el = scrollerRef.current;
        if (!el || suppress.current) return;
        const index = Math.round(el.scrollLeft / colWidth());
        const delta = index - anchorIndex;
        if (delta !== 0) onSettleDeltaDays(delta);
      }, 120);
    };

    const { effectiveEvents, beginDrag, draggingId } = useEventDrag(events, days);

    const { allDayEvents, timedByDay } = useMemo(
      () => bucketDayEvents(days, effectiveEvents),
      [days, effectiveEvents],
    );
    const nowLayout = getNowIndicatorLayout(days, now);

    // On first entry to a current day/week, put now comfortably below the
    // sticky header. This guard deliberately prevents event/sync rerenders from
    // moving a user's scroll position. Only auto-scroll when today is on the
    // strip, so paging to an unrelated week doesn't yank the scroll position.
    useLayoutEffect(() => {
      if (didInitialNowScroll.current || !nowLayout?.today) return;
      const scroller = scrollerRef.current;
      const body = bodyRef.current;
      if (!scroller || !body) return;

      const indicatorTop =
        body.offsetTop + body.clientHeight * (nowLayout.topPct / 100);
      scroller.scrollTo({
        left: scroller.scrollLeft,
        top: Math.max(0, indicatorTop - scroller.clientHeight * 0.35),
        behavior: "auto",
      });
      didInitialNowScroll.current = true;
    }, [nowLayout]);

    return (
      <div
        data-time-strip-scroller
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 overflow-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ scrollSnapType: "x mandatory", scrollPaddingLeft: GUTTER_TOTAL }}
      >
        <div
          className="sticky left-0 z-40 shrink-0 bg-background"
          style={{ flex: `0 0 ${GUTTER_TOTAL}px`, width: GUTTER_TOTAL }}
        >
          <GutterColumn allDayHeight={allDayHeight} now={now} />
        </div>
        <div
          className="flex shrink-0 flex-col"
          style={{
            flex: `0 0 calc(${days.length} * (100% - ${GUTTER_TOTAL}px) / ${columns})`,
          }}
        >
          <div className="sticky top-0 z-30">
            <PanelHeader
              days={days}
              allDayEvents={allDayEvents}
              allDayHeight={allDayHeight}
            />
          </div>
          <div
            data-time-grid
            ref={bodyRef}
            className="relative grid flex-1"
            style={{
              gridTemplateColumns: dayColsTemplate(days.length),
              gridTemplateRows: "minmax(0, 1fr)",
              minHeight: MIN_DAY_HEIGHT,
              backgroundImage:
                "linear-gradient(to bottom, color-mix(in oklab, var(--border) 55%, transparent) 0 1px, transparent 1px)",
              backgroundSize: "100% calc(100% / 24)",
            }}
          >
            {days.map((day, i) => (
              <DayColumn
                key={day.getTime()}
                day={day}
                events={timedByDay[i]}
                snapAlign={(i - anchorIndex) % snapDays === 0}
                gridRef={bodyRef}
                beginDrag={beginDrag}
                draggingId={draggingId}
              />
            ))}
            {nowLayout && <NowIndicator layout={nowLayout} />}
          </div>
          {/* Breathing room below the last hour so the floating island never
              covers events. Real scroll content (not scroller padding) so it
              stays reachable in a short viewport; the per-column border-l
              continues the day dividers into the empty space. */}
          <div
            aria-hidden
            className="grid h-24 shrink-0"
            style={{ gridTemplateColumns: dayColsTemplate(days.length) }}
          >
            {days.map((day) => (
              <div key={day.getTime()} className="border-l border-border" />
            ))}
          </div>
        </div>
      </div>
    );
  },
);
