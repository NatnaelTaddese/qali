import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Whether an element is currently on screen. Unlike `useInViewOnce` this
 * toggles on every enter and leave, so a scene can pause its timers the moment
 * it scrolls away and pick up again when it comes back.
 */
export function useVisible<T extends Element>(threshold = 0.3) {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setVisible(entry.isIntersecting);
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return { ref, visible };
}

/**
 * A step counter for the auto-looping scenes. Each step holds for its own
 * duration, then advances and wraps. While `playing` is false no timer is
 * scheduled and the step is kept, so a cell that scrolls off mid-scene resumes
 * where it stopped rather than snapping back.
 *
 * Scenes render purely from `step`; CSS transitions carry the change between
 * steps, so this hook never touches the DOM and the loop degrades to a still
 * frame (step 0) wherever animation is off.
 */
export function useLoop(durations: readonly number[], playing: boolean) {
  const [step, setStep] = useState(0);
  const count = durations.length;
  useEffect(() => {
    if (!playing || count === 0) return;
    const id = window.setTimeout(
      () => setStep((s) => (s + 1) % count),
      durations[step % count],
    );
    return () => window.clearTimeout(id);
  }, [step, playing, durations, count]);
  const reset = useCallback(() => setStep(0), []);
  return { step, reset };
}
