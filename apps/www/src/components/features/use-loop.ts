import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Whether an element is currently on screen. Unlike `useInViewOnce` this
 * toggles on every enter and leave, so a scene can pause its timers the moment
 * it scrolls away and pick up again when it comes back. A hidden tab counts as
 * off screen too: intersection never changes when the tab is backgrounded, so
 * the document's visibility is folded in.
 */
export function useVisible<T extends Element>(threshold = 0.3) {
  const ref = useRef<T | null>(null);
  const [intersecting, setIntersecting] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setIntersecting(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setIntersecting(entry.isIntersecting);
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  useEffect(() => {
    const update = () => setDocumentVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return { ref, visible: intersecting && documentVisible };
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
  // Time already spent on the current step, so a pause (a cell flickering at
  // the visibility threshold, a hidden tab) resumes the remaining wait rather
  // than restarting the whole step.
  const remainingRef = useRef<number | null>(null);
  const stepRef = useRef(step);
  useEffect(() => {
    if (!playing || count === 0) return;
    if (stepRef.current !== step) {
      stepRef.current = step;
      remainingRef.current = null;
    }
    const wait = remainingRef.current ?? durations[step % count];
    const startedAt = Date.now();
    const id = window.setTimeout(() => {
      remainingRef.current = null;
      setStep((s) => (s + 1) % count);
    }, wait);
    return () => {
      window.clearTimeout(id);
      remainingRef.current = Math.max(0, wait - (Date.now() - startedAt));
    };
  }, [step, playing, durations, count]);
  const reset = useCallback(() => {
    remainingRef.current = null;
    setStep(0);
  }, []);
  return { step, reset };
}
