import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Shared data and helpers for the landing page's feature grid. Every scene is
 * deliberately self-contained — no Convex, no shared calendar code — but the
 * palette, geometry and copy mirror the real product so the miniatures read as
 * the actual app.
 */

/** A visible slice of a day, in minutes from midnight. */
export interface TimeWindow {
  start: number;
  end: number;
}

/** The assistant scene's window: 8am – 5pm. Nine hours keeps each hour row
 * tall enough for a card to show its title and time without clipping. */
export const DEFAULT_WINDOW: TimeWindow = { start: 8 * 60, end: 17 * 60 };

/** Hour marks across a window, inclusive of both edges. */
export function hoursIn(win: TimeWindow): number[] {
  const first = Math.ceil(win.start / 60);
  const last = Math.floor(win.end / 60);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

export function topPct(min: number, win: TimeWindow = DEFAULT_WINDOW) {
  return ((min - win.start) / (win.end - win.start)) * 100;
}

export function heightPct(
  start: number,
  end: number,
  win: TimeWindow = DEFAULT_WINDOW,
) {
  return ((end - start) / (win.end - win.start)) * 100;
}

export function formatTime(min: number) {
  const h = Math.floor(min / 60);
  const mm = min % 60;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${mm.toString().padStart(2, "0")} ${period}`;
}

export function formatRange(start: number, end: number) {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

export function hourLabel(hour: number) {
  const period = hour >= 12 ? "pm" : "am";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${period}`;
}

export interface PreviewEvent {
  id: string;
  /** Column index, Monday = 0. */
  day: number;
  /** Start / end in minutes from midnight. */
  start: number;
  end: number;
  title: string;
  /** One of the app's `--event-N` palette variables. */
  color: string;
}

export const BASE_EVENTS: PreviewEvent[] = [
  { id: "mon-design", day: 0, start: 9 * 60, end: 10 * 60, title: "Design review", color: "--event-6" },
  { id: "mon-lunch", day: 0, start: 12 * 60 + 30, end: 13 * 60 + 30, title: "Lunch", color: "--event-3" },
  { id: "tue-11", day: 1, start: 11 * 60, end: 11 * 60 + 30, title: "1:1 with Sam", color: "--event-4" },
  { id: "tue-road", day: 1, start: 15 * 60, end: 16 * 60, title: "Roadmap sync", color: "--event-1" },
  { id: "wed-prod", day: 2, start: 10 * 60, end: 11 * 60, title: "Product sync", color: "--event-5" },
  { id: "wed-focus", day: 2, start: 14 * 60, end: 16 * 60, title: "Focus block", color: "--event-2" },
  { id: "thu-int", day: 3, start: 13 * 60, end: 14 * 60, title: "Interview", color: "--event-7" },
  { id: "thu-design", day: 3, start: 16 * 60, end: 17 * 60, title: "Design review", color: "--event-6" },
  { id: "fri-demo", day: 4, start: 11 * 60, end: 12 * 60, title: "Demo", color: "--event-8" },
  { id: "fri-priya", day: 4, start: 15 * 60 + 30, end: 16 * 60, title: "1:1 with Priya", color: "--event-4" },
];

export interface GhostSlot {
  day: number;
  start: number;
  end: number;
  label: string;
}

export type SceneId = "move" | "find" | "clear";

export interface Scene {
  id: SceneId;
  prompt: string;
  /** The in-flight line, echoing the assistant panel's real tool labels. */
  thinking: string;
  confirmation: string;
}

export const SCENES: Scene[] = [
  {
    id: "move",
    prompt: "Move Focus block to the morning",
    thinking: "Drafting a reschedule",
    confirmation: "Moved Focus block to 8:00 AM",
  },
  {
    id: "find",
    prompt: "Find 30 min on Thursday",
    thinking: "Looking for open time",
    confirmation: "Found 30 min Thursday at 10:00 AM",
  },
  {
    id: "clear",
    prompt: "Clear Friday afternoon",
    thinking: "Drafting a cancellation",
    confirmation: "Cleared Friday afternoon",
  },
];

export function sceneById(id: SceneId): Scene {
  const scene = SCENES.find((s) => s.id === id);
  if (!scene) throw new Error(`Unknown scene: ${id}`);
  return scene;
}

/** The grid the assistant scene shows once a set of scenes has been applied.
 * Pure, so the auto loop and the clickable chips render through one path. */
export function deriveGrid(applied: ReadonlySet<SceneId>): {
  events: PreviewEvent[];
  ghost: GhostSlot | null;
  removed: ReadonlySet<string>;
} {
  const events = applied.has("move")
    ? BASE_EVENTS.map((e) =>
        e.id === "wed-focus" ? { ...e, start: 8 * 60, end: 10 * 60 } : e,
      )
    : BASE_EVENTS;
  const ghost = applied.has("find")
    ? { day: 3, start: 10 * 60, end: 10 * 60 + 30, label: "Suggested" }
    : null;
  const removed = new Set<string>(applied.has("clear") ? ["fri-priya"] : []);
  return { events, ghost, removed };
}

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/** The assistant scene always shows Wed–Fri so every AI beat (move on Wed,
 * find on Thu, clear on Fri) stays on screen at every width. */
export const ASSISTANT_DAYS = [2, 3, 4];
export const WEEK_DAYS = [0, 1, 2, 3, 4];

/** This week's Monday–Friday, so headers show live dates and today lights up. */
export function useWeekDays() {
  return useMemo(() => {
    const now = new Date();
    const mondayOffset = (now.getDay() + 6) % 7; // 0 = Monday
    const monday = new Date(now);
    monday.setDate(now.getDate() - mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 5 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
    return { days, todayIndex: mondayOffset <= 4 ? mondayOffset : -1 };
  }, []);
}

/** matchMedia as state. Guarded so static renders (tests) have no window. */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useReducedMotion() {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** Fires once when the element scrolls into view. The section title sits below
 * the fold, so its chroma reveal is gated on this rather than playing on load
 * (where the sweep would finish before the reader ever reaches it). */
export function useInViewOnce<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -15% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView]);
  return { ref, inView };
}
