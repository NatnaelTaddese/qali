import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

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
    const suppressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const settleCallback = useRef<(() => void) | undefined>(undefined);
    // Ignore scroll events caused by our own programmatic recentering.
    const suppress = useRef(false);

    const panelWidth = useCallback(() => {
      const el = scrollerRef.current;
      if (!el) return 1;
      return Math.max(el.clientWidth - gutterWidth, 1);
    }, [gutterWidth]);

    const finishScroll = useCallback(() => {
      const el = scrollerRef.current;
      if (!el || suppress.current) return;
      const index = Math.round(el.scrollLeft / panelWidth());
      const delta = index - centerIndex;
      const onSettled = settleCallback.current;
      settleCallback.current = undefined;
      if (delta !== 0) onSettleDelta(delta);
      onSettled?.();
    }, [centerIndex, onSettleDelta, panelWidth]);

    const scheduleSettle = useCallback(() => {
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(finishScroll, 120);
    }, [finishScroll]);

    const cancelPendingPulse = () => {
      settleCallback.current = undefined;
    };

    const scrollToIndex = useCallback(
      (index: number, behavior: ScrollBehavior, onSettled?: () => void) => {
        const el = scrollerRef.current;
        if (!el) return;
        settleCallback.current = onSettled;
        if (behavior === "auto") {
          suppress.current = true;
          clearTimeout(suppressTimer.current);
          suppressTimer.current = setTimeout(() => {
            suppress.current = false;
          }, 80);
        }
        el.scrollTo({ left: index * panelWidth(), behavior });
        if (behavior === "smooth") scheduleSettle();
      },
      [panelWidth, scheduleSettle],
    );

    useImperativeHandle(ref, () => ({ scrollToIndex }), [scrollToIndex]);

    // Recenter instantly whenever the buffered window rebuilds (anchor/view
    // change) or the first mount. `pageStarts` is a fresh array each time.
    useLayoutEffect(() => {
      clearTimeout(settleTimer.current);
      scrollToIndex(centerIndex, "auto");
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pageStarts, gutterWidth]);

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
        clearTimeout(suppressTimer.current);
      },
      [],
    );

    const onScroll = () => {
      if (suppress.current) return;
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
