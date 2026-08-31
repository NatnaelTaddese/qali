import { useCallback, type RefCallback } from "react";

/** The shadcn `scroll-fade-*` utilities drive their mask with scroll-driven
 * animations. Where those are missing (Firefox), the utility's own fallback
 * paints BOTH fades statically, so content at the very top of the scroller
 * sits under a fade that never lifts. */
const hasScrollTimeline =
  typeof CSS !== "undefined" && CSS.supports("animation-timeline", "scroll()");

/** How far the native version scrolls before a fade is fully revealed:
 * `--scroll-fade-reveal`, default `calc(var(--spacing) * 24)` = 6rem. */
const REVEAL_PX = 96;

/**
 * Fallback driver for a `scroll-fade-y` scroller. Attach the returned ref to
 * the scrolling element. In browsers with scroll-driven animations this does
 * nothing (the CSS animation outranks inline styles anyway); elsewhere it
 * mirrors the scroll position into `--scroll-fade-t`/`--scroll-fade-b`, which
 * as inline styles override the utility's static `@supports not` fallback.
 *
 * Returns a React 19 ref with a per-node cleanup function — with
 * AnimatePresence an exiting node unmounts AFTER its replacement mounts, so a
 * shared "last cleanup" slot would tear down the new node's wiring.
 */
export function useScrollFadeFallback(): RefCallback<HTMLElement> {
  return useCallback((node: HTMLElement | null) => {
    if (!node || hasScrollTimeline) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      // scrollTop can exceed maxScroll by a fraction of a pixel, so clamp both
      // ends — a negative factor would push a gradient stop past its edge.
      const clamp = (n: number) => Math.min(1, Math.max(0, n));
      const maxScroll = node.scrollHeight - node.clientHeight;
      const top = maxScroll > 0 ? clamp(node.scrollTop / REVEAL_PX) : 0;
      const bottom =
        maxScroll > 0 ? clamp((maxScroll - node.scrollTop) / REVEAL_PX) : 0;
      // `--_scroll-fade-size-*` is set on the element by the utility itself;
      // the literal fallback matches its default of min(12%, spacing*10).
      node.style.setProperty(
        "--scroll-fade-t",
        `calc(var(--_scroll-fade-size-t, min(12%, 2.5rem)) * ${top})`,
      );
      node.style.setProperty(
        "--scroll-fade-b",
        `calc(var(--_scroll-fade-size-b, min(12%, 2.5rem)) * ${bottom})`,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    node.addEventListener("scroll", schedule, { passive: true });
    // The pane is fixed-height, so content growth (a section's query landing)
    // shows up as DOM churn rather than a resize of the node itself — watch
    // both so the bottom fade appears the moment content overflows.
    const resize = new ResizeObserver(schedule);
    resize.observe(node);
    const mutations = new MutationObserver(schedule);
    mutations.observe(node, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      node.removeEventListener("scroll", schedule);
      resize.disconnect();
      mutations.disconnect();
      node.style.removeProperty("--scroll-fade-t");
      node.style.removeProperty("--scroll-fade-b");
    };
  }, []);
}
