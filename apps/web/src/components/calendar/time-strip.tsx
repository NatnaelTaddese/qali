import { api } from "@qali/backend/convex/_generated/api";
import { useQuery } from "convex/react";
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
  allDayBandHeight,
  bucketDayEvents,
  dayColsTemplate,
  GUTTER_TOTAL,
  layoutAllDayEvents,
  MIN_DAY_HEIGHT,
  MS_PER_DAY,
  MS_PER_MINUTE,
  SETTLE_BACKSTOP_MS,
  SETTLE_IDLE_MS,
  SNAP_EPSILON,
  SUPPORTS_SCROLL_END,
  TIME_GRID_BOTTOM_SPACER_HEIGHT,
  type CalendarEvent,
  visibleAllDayMetrics,
} from "./lib";
import {
  getNowIndicatorLayout,
  NowIndicator,
  type NowIndicatorLayout,
} from "./now-indicator";
import { PanelHeader } from "./panel-header";
import type { Reveal } from "./today-pulse";
import { useEventDrag } from "./use-event-drag";

/** Stable empty fallbacks: a fresh `[]` per render would give every day column
 * a new prop identity and defeat its memoization. */
const NO_CONTACTS: never[] = [];
const NO_BOOKINGS: never[] = [];

export interface TimeStripHandle {
  /** Scroll to a day column index. Use "smooth" for button nav. */
  scrollToIndex: (index: number, behavior: ScrollBehavior) => void;
  /** Smooth-scroll a day column to the left edge and ease vertically to
   * `topPct` (0–100 of the day height), or keep the current vertical position
   * when `topPct` is null — a real continuous scroll to an on-strip target. */
  scrollToColumn: (
    index: number,
    topPct: number | null,
    onSettled: () => void,
  ) => void;
  /** Smooth-scroll to a day column and ease vertically to the current-time line
   * — a real continuous scroll to Today when it's on-strip. */
  scrollToTodayColumn: (index: number, onSettled: () => void) => void;
  /** Arm the next recenter to also position vertically at `topPct` (0–100), or
   * at the current-time line when passed "now" — used when a reveal's view-
   * transition rebuilds the strip off-buffer. */
  primeCenterAt: (topPct: number | "now" | null) => void;
  /** Arm the next recenter to position vertically at the current-time line. */
  primeCenterNow: () => void;
}

interface TimeStripProps {
  /** All buffered day columns; the anchor sits at `anchorIndex`. */
  days: Date[];
  /** Index of the leftmost visible (anchor) day within `days`. */
  anchorIndex: number;
  /** Visible columns (1 for day view, 7 for week). */
  columns: number;
  /** Events for the whole strip range; bucketed per day internally. */
  events: CalendarEvent[];
  /** Fired once scrolling settles `deltaDays` away from the anchor. */
  onSettleDeltaDays: (deltaDays: number) => void;
  /** The active reveal target; pulses the matching date pill, event card, or
   * request block once a scroll to it settles. */
  reveal: Reveal;
}

/**
 * A continuous horizontal strip of day columns with a pinned time gutter.
 * Scrolling snaps to each day column, so gentle gestures can move one day while
 * stronger gestures retain native momentum. On settle it reports how many days
 * moved; the parent re-anchors and the strip silently recenters.
 *
 * Column width is expressed purely in CSS (no measured state / ResizeObserver);
 * JS reads `clientWidth` only on demand to translate a day index into a scroll
 * offset.
 */
export const TimeStrip = forwardRef<TimeStripHandle, TimeStripProps>(
  function TimeStrip(
    { days, anchorIndex, columns, events, onSettleDeltaDays, reveal },
    ref,
  ) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const scrollRaf = useRef<number | null>(null);
    const lastScrollLeft = useRef(0);
    const todaySettleCallback = useRef<(() => void) | undefined>(undefined);
    /** Set once a scroll that should produce a settle has actually moved. */
    const settlePending = useRef(false);
    const didInitialNowScroll = useRef(false);
    // Arms the next recenter to also position vertically. `false` means don't;
    // a primed value is a pct (0–100), null (keep current), or "now" (resolve
    // against the current-time line at recenter time, after an off-buffer
    // rebuild puts today on the strip).
    const centerPrimedRef = useRef(false);
    const centerAtPctRef = useRef<number | "now" | null>(null);
    const nowLayoutRef = useRef<NowIndicatorLayout | null>(null);
    const userInteractedRef = useRef(false);
    const [now, setNow] = useState(() => Date.now());
    const [visibleStartIdx, setVisibleStartIdx] = useState(anchorIndex);
    const contacts = useQuery(api.contacts.listContacts) ?? NO_CONTACTS;
    const contactPhotos = useMemo(() => {
      const photos = new Map<string, string>();
      for (const contact of contacts) {
        if (!contact.photoUrl) continue;
        for (const email of contact.emails) {
          photos.set(email.toLowerCase(), contact.photoUrl);
        }
      }
      return photos;
    }, [contacts]);

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

    // Read through a ref so `finishScroll` — and everything memoized on it,
    // up to the recentering layout effect — keeps a stable identity even if a
    // caller passes a fresh closure each render.
    const onSettleRef = useRef(onSettleDeltaDays);
    onSettleRef.current = onSettleDeltaDays;

    // Deliberately unguarded: settling always reads the real scroll position.
    // A settle triggered by our own recenter lands exactly on `anchorIndex`, so
    // it computes delta 0 and does nothing — which is why suppressing those is
    // an optimization at best. Gating this on a "programmatic scroll in flight"
    // flag risks the flag sticking (a target computed from a stale column width
    // is never reached) and silently disabling navigation altogether.
    const finishScroll = useCallback(() => {
      const el = scrollerRef.current;
      clearTimeout(settleTimer.current);
      // `scrollend` fires for this scroller's vertical axis too, and settling
      // on a scroll that never moved horizontally would consume a pending
      // Today pulse without the strip having gone anywhere.
      if (!el || !settlePending.current) return;
      settlePending.current = false;
      const index = Math.max(
        0,
        Math.min(Math.round(el.scrollLeft / colWidth()), days.length - columns),
      );
      const delta = index - anchorIndex;
      const onSettled = todaySettleCallback.current;
      todaySettleCallback.current = undefined;
      if (delta !== 0) onSettleRef.current(delta);
      onSettled?.();
    }, [anchorIndex, colWidth, columns, days.length]);

    // `scrollend` is the real signal, but Safari only shipped it in 26.2, so an
    // inactivity timer runs alongside: primary where the event is missing, and
    // a slower backstop where it exists (a scroll cancelled by snap correction
    // can skip `scrollend`). Re-armed from `onScroll`, so it measures time since
    // the last scroll event — during a smooth animation that keeps pushing
    // out, which is why arming it up front used to settle mid-flight.
    const finishScrollRef = useRef(finishScroll);
    finishScrollRef.current = finishScroll;
    const scheduleSettle = useCallback(() => {
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(
        () => finishScrollRef.current(),
        SUPPORTS_SCROLL_END ? SETTLE_BACKSTOP_MS : SETTLE_IDLE_MS,
      );
    }, []);

    useEffect(() => {
      const el = scrollerRef.current;
      if (!el || !SUPPORTS_SCROLL_END) return;
      const onScrollEnd = () => finishScrollRef.current();
      el.addEventListener("scrollend", onScrollEnd);
      return () => el.removeEventListener("scrollend", onScrollEnd);
    }, []);

    const cancelPendingTodayPulse = () => {
      userInteractedRef.current = true;
      todaySettleCallback.current = undefined;
    };

    const scrollToIndex = useCallback(
      (index: number, behavior: ScrollBehavior) => {
        const el = scrollerRef.current;
        if (!el) return;
        todaySettleCallback.current = undefined;
        const target = index * colWidth();
        if (behavior === "auto") setVisibleStartIdx(index);
        // Already there: `scrollTo` would emit no scroll event, so skip it
        // rather than wait on a settle that can never arrive.
        if (Math.abs(el.scrollLeft - target) <= SNAP_EPSILON) return;
        el.scrollTo({ left: target, behavior });
      },
      [colWidth],
    );

    // Vertical scroll offset that places a given day-fraction `pct` (0–100)
    // ~35% down the viewport. `null` keeps the current position (used when the
    // target has no time — e.g. an all-day item, or today off-strip).
    const scrollTopForPct = useCallback((pct: number | null) => {
      const el = scrollerRef.current;
      const body = bodyRef.current;
      if (!el) return 0;
      if (pct == null || !body) return el.scrollTop;
      return Math.max(
        0,
        body.offsetTop +
          body.clientHeight * (pct / 100) -
          el.clientHeight * 0.35,
      );
    }, []);

    // The current-time line's pct when today is on-strip, else null.
    const nowPct = useCallback(() => {
      const layout = nowLayoutRef.current;
      return layout?.today ? layout.topPct : null;
    }, []);

    const scrollToColumn = useCallback(
      (index: number, topPct: number | null, onSettled: () => void) => {
        const el = scrollerRef.current;
        if (!el) return;
        didInitialNowScroll.current = true;
        const left = index * colWidth();
        const top = scrollTopForPct(topPct);
        // No movement means no scroll event and therefore no settle, so run the
        // pulse callback directly rather than waiting for one that never comes.
        if (
          Math.abs(el.scrollLeft - left) <= SNAP_EPSILON &&
          Math.abs(el.scrollTop - top) <= SNAP_EPSILON
        ) {
          todaySettleCallback.current = undefined;
          onSettled();
          return;
        }
        todaySettleCallback.current = onSettled;
        // This scroll may only move vertically (the target column already
        // anchored), which `onScroll` deliberately ignores — so arm the settle
        // here or the pulse would wait on one that never comes.
        settlePending.current = true;
        scheduleSettle();
        el.scrollTo({ left, top, behavior: "smooth" });
      },
      [colWidth, scrollTopForPct, scheduleSettle],
    );

    const scrollToTodayColumn = useCallback(
      (index: number, onSettled: () => void) =>
        scrollToColumn(index, nowPct(), onSettled),
      [scrollToColumn, nowPct],
    );

    const primeCenterAt = useCallback((topPct: number | "now" | null) => {
      clearTimeout(settleTimer.current);
      todaySettleCallback.current = undefined;
      centerPrimedRef.current = true;
      centerAtPctRef.current = topPct;
    }, []);

    const primeCenterNow = useCallback(
      () => primeCenterAt("now"),
      [primeCenterAt],
    );

    useImperativeHandle(
      ref,
      () => ({
        scrollToIndex,
        scrollToColumn,
        scrollToTodayColumn,
        primeCenterAt,
        primeCenterNow,
      }),
      [
        scrollToIndex,
        scrollToColumn,
        scrollToTodayColumn,
        primeCenterAt,
        primeCenterNow,
      ],
    );

    // Recenter when the strip rebuilds (anchor/view change) or mounts. A primed
    // reveal also parks vertically (at the revealed time, or the current-time
    // line for a Today jump) so the freshly built (off-buffer) view is already
    // centered under the transition.
    //
    // Every dependency here must be stable across unrelated parent renders:
    // `days` changes identity only when the parent's layout memo recomputes,
    // and `scrollToIndex`/`colWidth`/`scrollTopForPct`/`nowPct` are constant for
    // a given view. If one of them starts churning, this effect resets
    // `scrollLeft` mid-gesture and the strip visibly snaps back to a different
    // week.
    useLayoutEffect(() => {
      const el = scrollerRef.current;
      clearTimeout(settleTimer.current);
      // The all-day cards ease their left/width as spans clamp at the scroll
      // edge. A recenter rebuilds the day window and jumps every card's buffer-
      // relative position, so flag it — `group-data-[recenter]` suppresses that
      // easing for this commit (and the visibleStartIdx reset it triggers) so
      // the cards snap into place instead of sliding.
      let raf = 0;
      if (el) {
        el.setAttribute("data-recenter", "");
        raf = requestAnimationFrame(() => el.removeAttribute("data-recenter"));
      }
      if (centerPrimedRef.current && el) {
        const primed = centerAtPctRef.current;
        centerPrimedRef.current = false;
        centerAtPctRef.current = null;
        setVisibleStartIdx(anchorIndex);
        didInitialNowScroll.current = true;
        // "now" resolves against the freshly-rebuilt layout, which now has today
        // on the strip; a plain pct/null is used as-is.
        const pct = primed === "now" ? nowPct() : primed;
        el.scrollTo({
          left: anchorIndex * colWidth(),
          top: scrollTopForPct(pct),
          behavior: "auto",
        });
        return () => cancelAnimationFrame(raf);
      }
      scrollToIndex(anchorIndex, "auto");
      return () => cancelAnimationFrame(raf);
    }, [days, anchorIndex, scrollToIndex, colWidth, scrollTopForPct, nowPct]);

    // Keep the anchor centered only when the strip's width actually changes.
    // Height-only window resizes happen while mobile browser chrome collapses
    // during a vertical scroll and must never yank the horizontal position.
    const lastWidth = useRef(0);
    useEffect(() => {
      const el = scrollerRef.current;
      if (!el || typeof ResizeObserver === "undefined") return;
      lastWidth.current = el.clientWidth;
      const observer = new ResizeObserver(() => {
        const width = el.clientWidth;
        if (width === lastWidth.current) return;
        lastWidth.current = width;
        scrollToIndex(anchorIndex, "auto");
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, [anchorIndex, scrollToIndex]);

    useEffect(
      () => () => {
        clearTimeout(settleTimer.current);
        if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current);
      },
      [],
    );

    const onScroll = () => {
      const el = scrollerRef.current;
      if (!el) return;
      const left = el.scrollLeft;
      // The scroller owns both axes; a vertical scroll must not arm a settle or
      // force a layout read for a horizontal position that hasn't moved.
      if (left === lastScrollLeft.current) return;
      lastScrollLeft.current = left;
      settlePending.current = true;
      scheduleSettle();
      if (scrollRaf.current !== null) return;
      scrollRaf.current = requestAnimationFrame(() => {
        scrollRaf.current = null;
        const current = scrollerRef.current;
        if (!current) return;
        const index = Math.max(
          0,
          Math.min(
            Math.round(current.scrollLeft / colWidth()),
            days.length - columns,
          ),
        );
        setVisibleStartIdx((prev) => (prev === index ? prev : index));
      });
    };

    const { effectiveEvents, beginDrag, draggingId } = useEventDrag(events, days);

    const { allDayEvents, timedByDay } = useMemo(
      () => bucketDayEvents(days, effectiveEvents),
      [days, effectiveEvents],
    );

    // The dock already holds this no-argument subscription. Convex shares the
    // live result, so moving the date window never clears and reloads bookings.
    const bookings = useQuery(api.booking.listPendingBookings) ?? NO_BOOKINGS;
    const bookingsByDay = useMemo(() => {
      const buckets: (typeof bookings)[] = days.map(() => []);
      for (const booking of bookings) {
        // Also enforce the deadline locally so legacy rows disappear while the
        // expiration sweep catches up.
        if (booking.endMs <= now) continue;
        days.forEach((day, i) => {
          const dayStartMs = day.getTime();
          if (
            booking.startMs < dayStartMs + MS_PER_DAY &&
            booking.endMs > dayStartMs
          ) {
            buckets[i].push(booking);
          }
        });
      }
      return buckets;
    }, [days, bookings, now]);
    // Clamp on the render path: switching week→day shrinks `days` (31→13)
    // while a stale `visibleStartIdx` from the wider strip survives until the
    // recentering effect commits, so indexing `days` unclamped can read past
    // the end. The effect corrects the state on the next commit either way.
    const maxStartIdx = Math.max(0, days.length - columns);
    const startIdx = Math.min(Math.max(visibleStartIdx, 0), maxStartIdx);
    const visibleEndIdx = Math.min(startIdx + columns - 1, days.length - 1);
    const allDayLayout = useMemo(
      () => layoutAllDayEvents(days, allDayEvents, startIdx, visibleEndIdx),
      [days, allDayEvents, startIdx, visibleEndIdx],
    );
    const visibleRangeKey = `${days[startIdx]?.getTime() ?? 0}:${columns}`;
    const [expandedAllDayRange, setExpandedAllDayRange] = useState<string>();
    const allDayExpanded = expandedAllDayRange === visibleRangeKey;
    const { laneCount: visibleAllDayLaneCount, hiddenEventCount } = useMemo(
      () => visibleAllDayMetrics(allDayLayout, startIdx, visibleEndIdx),
      [allDayLayout, startIdx, visibleEndIdx],
    );
    const allDayHeight = allDayBandHeight(
      visibleAllDayLaneCount,
      allDayExpanded,
    );
    const nowLayout = getNowIndicatorLayout(days, now);
    // Expose the latest layout to the imperative scroll helpers (which run
    // outside render) without threading it through their dependency arrays.
    nowLayoutRef.current = nowLayout;

    // On first entry to a current day/week, put now comfortably below the
    // sticky header. This guard deliberately prevents event/sync rerenders from
    // moving a user's scroll position. Only auto-scroll when today is on the
    // strip, so paging to an unrelated week doesn't yank the scroll position.
    useLayoutEffect(() => {
      if (didInitialNowScroll.current || !nowLayout?.today) return;
      if (userInteractedRef.current) {
        didInitialNowScroll.current = true;
        return;
      }
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
        onPointerDown={cancelPendingTodayPulse}
        onTouchStart={cancelPendingTodayPulse}
        onWheel={cancelPendingTodayPulse}
        className="group/strip flex min-h-0 flex-1 overflow-auto overscroll-x-contain bg-calendar-header [overflow-anchor:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ scrollSnapType: "x mandatory", scrollPaddingLeft: GUTTER_TOTAL }}
      >
        <div
          className="sticky left-0 z-[60] shrink-0 overflow-x-clip bg-background"
          style={{ flex: `0 0 ${GUTTER_TOTAL}px`, width: GUTTER_TOTAL }}
        >
          <GutterColumn
            allDayHeight={allDayHeight}
            allDayExpanded={allDayExpanded}
            hiddenAllDayEventCount={hiddenEventCount}
            onToggleAllDay={() =>
              setExpandedAllDayRange(allDayExpanded ? undefined : visibleRangeKey)
            }
            now={now}
          />
        </div>
        <div
          className="flex shrink-0 flex-col"
          style={{
            flex: `0 0 calc(${days.length} * (100% - ${GUTTER_TOTAL}px) / ${columns})`,
          }}
        >
          <div className="sticky top-0 z-30 shrink-0">
            <PanelHeader
              days={days}
              allDayEvents={allDayLayout}
              allDayHeight={allDayHeight}
              allDayExpanded={allDayExpanded}
              reveal={reveal}
            />
          </div>
          <div
            data-time-grid
            ref={bodyRef}
            className="relative grid flex-1 bg-background"
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
                gridRef={bodyRef}
                beginDrag={beginDrag}
                 draggingId={draggingId}
                 laneLayout={columns === 1}
                 contactPhotos={contactPhotos}
                 bookings={bookingsByDay[i]}
                 reveal={reveal}
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
            className="grid shrink-0 bg-background"
            style={{
              gridTemplateColumns: dayColsTemplate(days.length),
              height: TIME_GRID_BOTTOM_SPACER_HEIGHT,
            }}
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
