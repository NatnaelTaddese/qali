import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

import {
  SETTLE_BACKSTOP_MS,
  SETTLE_IDLE_MS,
  SNAP_EPSILON,
  SUPPORTS_SCROLL_END,
} from "./lib";

export interface CalendarPagerHandle {
  /** Scroll to a rendered page index. Use "smooth" for button nav. */
  scrollToIndex: (
    index: number,
    behavior: ScrollBehavior,
    onSettled?: () => void,
  ) => void;
}

interface CalendarPagerProps {
  /** Buffered page starts, with the anchor at `centerIndex`. */
  pageStarts: Date[];
  /** Index of the anchor page within `pageStarts`. */
  centerIndex: number;
  /** Pinned left column (day/week views); omit for month. */
  gutter?: ReactNode;
  /** Width of the pinned gutter in px (0 when absent). */
  gutterWidth: number;
  renderPage: (start: Date) => ReactNode;
  /** Fired once scrolling settles on a page `delta` away from center. */
  onSettleDelta: (delta: number) => void;
}

/**
 * Horizontal, snap-paged strip of calendar pages with an optional pinned
 * gutter. Neighbouring pages are already rendered (the buffer), so paging is
 * instant. On settle it reports how many pages moved; the parent re-anchors,
 * which rebuilds the buffer and this component silently recenters the scroll —
 * the standard infinite-carousel trick.
 */
export const CalendarPager = forwardRef<CalendarPagerHandle, CalendarPagerProps>(
  function CalendarPager(
    { pageStarts, centerIndex, gutter, gutterWidth, renderPage, onSettleDelta },
    ref,
  ) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const settleCallback = useRef<(() => void) | undefined>(undefined);
    const lastScrollLeft = useRef(0);
    /** Set once a scroll that should produce a settle has actually moved. */
    const settlePending = useRef(false);

    const panelWidth = useCallback(() => {
      const el = scrollerRef.current;
      if (!el) return 1;
      return Math.max(el.clientWidth - gutterWidth, 1);
    }, [gutterWidth]);

    // Read through a ref so `finishScroll` — and everything memoized on it,
    // up to the recentering layout effect — keeps a stable identity even if a
    // caller passes a fresh closure each render.
    const onSettleRef = useRef(onSettleDelta);
    onSettleRef.current = onSettleDelta;

    // Deliberately unguarded — see the note in time-strip.tsx: a settle caused
    // by our own recenter computes delta 0, so suppressing it buys nothing and
    // a stuck suppression flag would disable navigation entirely.
    const finishScroll = useCallback(() => {
      const el = scrollerRef.current;
      clearTimeout(settleTimer.current);
      // `scrollend` covers the vertical axis too; only settle if the pager
      // actually moved horizontally.
      if (!el || !settlePending.current) return;
      settlePending.current = false;
      const index = Math.max(
        0,
        Math.min(
          Math.round(el.scrollLeft / panelWidth()),
          pageStarts.length - 1,
        ),
      );
      const delta = index - centerIndex;
      const onSettled = settleCallback.current;
      settleCallback.current = undefined;
      if (delta !== 0) onSettleRef.current(delta);
      onSettled?.();
    }, [centerIndex, pageStarts.length, panelWidth]);

    // See time-strip.tsx: `scrollend` where available, an inactivity timer
    // otherwise, and never armed up front against a smooth animation.
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

    const cancelPendingPulse = () => {
      settleCallback.current = undefined;
    };

    const scrollToIndex = useCallback(
      (index: number, behavior: ScrollBehavior, onSettled?: () => void) => {
        const el = scrollerRef.current;
        if (!el) return;
        const target = index * panelWidth();
        // Already there: `scrollTo` emits no scroll event, so run any settle
        // callback directly rather than wait for one that never arrives.
        if (Math.abs(el.scrollLeft - target) <= SNAP_EPSILON) {
          settleCallback.current = undefined;
          onSettled?.();
          return;
        }
        settleCallback.current = onSettled;
        el.scrollTo({ left: target, behavior });
      },
      [panelWidth],
    );

    useImperativeHandle(ref, () => ({ scrollToIndex }), [scrollToIndex]);

    // Recenter instantly whenever the buffered window rebuilds (anchor/view
    // change) or the first mount. `pageStarts` is a fresh array each time.
    //
    // Every dependency here must be stable across unrelated parent renders; a
    // churning `scrollToIndex` would reset `scrollLeft` mid-gesture and snap
    // the pager back to a different month.
    useLayoutEffect(() => {
      clearTimeout(settleTimer.current);
      scrollToIndex(centerIndex, "auto");
    }, [pageStarts, gutterWidth, centerIndex, scrollToIndex]);

    // Re-center only when the viewport *width* actually changes, so height
    // changes and no-op observer fires don't fight an in-flight navigation.
    const lastWidth = useRef(0);
    useEffect(() => {
      const el = scrollerRef.current;
      if (!el) return;
      lastWidth.current = el.clientWidth;
      const observer = new ResizeObserver(() => {
        const width = el.clientWidth;
        if (width === lastWidth.current) return;
        lastWidth.current = width;
        scrollToIndex(centerIndex, "auto");
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, [centerIndex, scrollToIndex]);

    useEffect(
      () => () => {
        clearTimeout(settleTimer.current);
      },
      [],
    );

    const onScroll = () => {
      const el = scrollerRef.current;
      if (!el) return;
      const left = el.scrollLeft;
      // The scroller owns both axes; vertical scrolling must not arm a settle.
      if (left === lastScrollLeft.current) return;
      lastScrollLeft.current = left;
      settlePending.current = true;
      scheduleSettle();
    };

    return (
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        onPointerDown={cancelPendingPulse}
        onTouchStart={cancelPendingPulse}
        onWheel={cancelPendingPulse}
        className="flex min-h-0 flex-1 overflow-auto overscroll-x-contain [overflow-anchor:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ scrollSnapType: "x mandatory", scrollPaddingLeft: gutterWidth }}
      >
        {gutter && (
          <div
            className="sticky left-0 z-40 shrink-0 bg-background"
            style={{ flex: `0 0 ${gutterWidth}px`, width: gutterWidth }}
          >
            {gutter}
          </div>
        )}
        {pageStarts.map((start) => (
          <div
            key={start.getTime()}
            className="shrink-0"
            style={{
              flex: `0 0 calc(100% - ${gutterWidth}px)`,
              scrollSnapAlign: "start",
              scrollSnapStop: "always",
            }}
          >
            {renderPage(start)}
          </div>
        ))}
      </div>
    );
  },
);
