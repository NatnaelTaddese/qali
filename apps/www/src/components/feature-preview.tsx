import { HalftoneCmyk } from "@paper-design/shaders-react";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A miniature, interactive slice of the app's week view for the landing page.
 * It is deliberately self-contained — no Convex, no shared calendar code — but
 * mirrors the real event-card treatment (tinted `--event-*` fill, left accent
 * bar, rounded ring) so the preview reads as the actual product.
 *
 * The AI story is the point: three suggestion chips each run a short "thinking"
 * beat and then mutate the grid the way the assistant would — moving a block,
 * surfacing a found slot, clearing an afternoon — with CSS transitions carrying
 * the change. The whole screen fades toward its bottom edge so it reads as the
 * calendar rising out of the page rather than a boxed screenshot.
 */

/** Visible window: 8am – 6pm, expressed in minutes from midnight. */
const WINDOW_START = 8 * 60;
const WINDOW_END = 18 * 60;
const WINDOW_SPAN = WINDOW_END - WINDOW_START;

const HOUR_LINES = Array.from(
  { length: (WINDOW_END - WINDOW_START) / 60 + 1 },
  (_, i) => WINDOW_START / 60 + i,
);

interface PreviewEvent {
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

const BASE_EVENTS: PreviewEvent[] = [
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

interface GhostSlot {
  day: number;
  start: number;
  end: number;
  label: string;
}

type SceneId = "move" | "find" | "clear";

interface Scene {
  id: SceneId;
  prompt: string;
  /** Rotating "thinking" line, echoing the assistant's tool labels. */
  thinking: string;
  confirmation: string;
}

const SCENES: Scene[] = [
  {
    id: "move",
    prompt: "Move my Focus block to the morning",
    thinking: "Drafting a reschedule",
    confirmation: "Moved Focus block to 8:00 AM",
  },
  {
    id: "find",
    prompt: "Find 30 minutes for a call Thursday",
    thinking: "Looking for open time",
    confirmation: "Found 30 min Thursday at 10:00 AM",
  },
  {
    id: "clear",
    prompt: "Clear my Friday afternoon",
    thinking: "Drafting a cancellation",
    confirmation: "Cleared Friday afternoon",
  },
];

/** This week's Monday–Friday, so the header shows live dates and today lights up. */
function useWeekDays() {
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

/** True below Tailwind's `sm` breakpoint. Drives the 3-day (mobile) vs 5-day
 * (desktop) week window. matchMedia, not a rAF loop, so it is unaffected by the
 * animation throttling that pushed the rest of this component onto CSS. */
function useIsMobile() {
  const query = "(max-width: 639px)";
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mobile;
}

/** Fires once when the element scrolls into view. The section title sits below
 * the fold, so its chroma reveal is gated on this rather than playing on load
 * (where the sweep would finish before the reader ever reaches it). The negative
 * bottom `rootMargin` starts the sweep as the title clears the lower edge. */
function useInViewOnce<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
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

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/** Day indices rendered per layout. Mobile shows Wed–Fri so every AI scene
 * (move on Wed, find on Thu, clear on Fri) stays on screen. */
const DESKTOP_DAYS = [0, 1, 2, 3, 4];
const MOBILE_DAYS = [2, 3, 4];

function topPct(min: number) {
  return ((min - WINDOW_START) / WINDOW_SPAN) * 100;
}
function heightPct(start: number, end: number) {
  return ((end - start) / WINDOW_SPAN) * 100;
}
function formatRange(start: number, end: number) {
  const fmt = (m: number) => {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const period = h >= 12 ? "PM" : "AM";
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${mm.toString().padStart(2, "0")} ${period}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}
function hourLabel(hour: number) {
  const period = hour >= 12 ? "pm" : "am";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${period}`;
}

export function FeaturePreview() {
  const { days, todayIndex } = useWeekDays();
  const isMobile = useIsMobile();
  const visibleDays = isMobile ? MOBILE_DAYS : DESKTOP_DAYS;
  const todayPos = visibleDays.indexOf(todayIndex);
  const [events, setEvents] = useState<PreviewEvent[]>(BASE_EVENTS);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [ghost, setGhost] = useState<GhostSlot | null>(null);
  const [applied, setApplied] = useState<Set<SceneId>>(new Set());
  const [busy, setBusy] = useState<Scene | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const title = useInViewOnce<HTMLHeadingElement>();

  // The pill's width is intrinsic (message length + the Reset button toggling),
  // and `auto` widths don't transition. Measure the content's natural width and
  // drive the shell's explicit `width` from it, so it can tween between states.
  const pillContentRef = useRef<HTMLDivElement>(null);
  const [pillWidth, setPillWidth] = useState<number>();
  useEffect(() => {
    const el = pillContentRef.current;
    if (!el) return;
    const measure = () =>
      setPillWidth(Math.ceil(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nowMinutes = useMemo(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }, []);
  const nowVisible =
    todayPos !== -1 && nowMinutes >= WINDOW_START && nowMinutes <= WINDOW_END;

  function runScene(scene: Scene) {
    if (busy || applied.has(scene.id)) return;
    setConfirmation(null);
    setBusy(scene);
    window.setTimeout(() => {
      if (scene.id === "move") {
        setEvents((prev) =>
          prev.map((e) =>
            e.id === "wed-focus" ? { ...e, start: 8 * 60, end: 10 * 60 } : e,
          ),
        );
      } else if (scene.id === "find") {
        setGhost({
          day: 3,
          start: 10 * 60,
          end: 10 * 60 + 30,
          label: "Suggested",
        });
      } else if (scene.id === "clear") {
        // Keep the card mounted and fade it out via `animate` rather than
        // unmounting it — an exiting element that also carries `layout` can
        // stall inside AnimatePresence and never leave.
        setRemoved((prev) => new Set(prev).add("fri-priya"));
      }
      setApplied((prev) => new Set(prev).add(scene.id));
      setBusy(null);
      setConfirmation(scene.confirmation);
    }, 950);
  }

  function reset() {
    setEvents(BASE_EVENTS);
    setRemoved(new Set());
    setGhost(null);
    setApplied(new Set());
    setBusy(null);
    setConfirmation(null);
  }

  const hasChanges = applied.size > 0;

  return (
    <section className="relative overflow-hidden bg-background px-6 pb-14 pt-10 sm:pb-20 sm:pt-14">
      <div
        aria-hidden
        className="min-h-svh pointer-events-none absolute inset-0 z-0 bg-background rotate-180"
      >
            <HalftoneCmyk
              speed={0}
              size={0.08}
              gridNoise={0.16}
              type="ink"
              softness={1}
              contrast={1}
              gainC={0.3}
              gainM={0}
              gainY={0.2}
              gainK={0}
              floodC={0.15}
              floodM={0}
              floodY={0}
              floodK={0}
              scale={1}
              image="/hero-halftone.png"
              grainSize={0.5}
              fit="cover"
              colorBack="#00000000"
              colorC="#00B4FF"
              colorM="#FC519F"
              colorY="#FFD800"
              colorK="#231F20"
              style={{ width: "100%", height: "100%", backgroundColor: "#FBFAF5" }}
            />
            <div className="hero-shader-fade absolute inset-0" />
          </div>
      {/* Overlay: fades the section into the page background. Transparent at the
          very top (shader shows through) then ramps into the background early and
          fast — mostly opaque by ~45% and solid the rest of the way — rather than
          an even top-to-bottom linear fade. Sits above the shader (later in DOM,
          same z-0) but below the content (z-10). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundImage:
            "linear-gradient(to bottom, transparent 0%, color-mix(in oklab, var(--background) 65%, transparent) 22%, color-mix(in oklab, var(--background) 92%, transparent) 38%, var(--background) 50%)",
        }}
      />
      <div className="relative z-10 mx-auto flex max-w-2xl flex-col items-center gap-4 text-center">
        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground ring ring-black/10">
          Your week, on autopilot
        </span>
        <h2
          ref={title.ref}
          className={`chroma-text font-display text-3xl font-medium tracking-tight text-balance pb-[0.12em] -mb-[0.12em] sm:text-5xl${
            title.inView ? " chroma-text-reveal" : ""
          }`}
        >
          Just tell it what you need
        </h2>
        <p className="max-w-lg text-lg text-muted-foreground text-balance">
          Qali reads your whole week and makes the change for you
        </p>
      </div>

      <div className="relative z-10 mx-auto mt-12 max-w-4xl">
        {/* The screen. Rounded, ringed, tinted — then masked so it fades into the
            page toward the bottom rather than ending on a hard edge. */}
        <div className="feature-screen relative overflow-hidden rounded-[1.75rem] bg-card ring-1 ring-border shadow-[0_30px_80px_-40px_rgba(24,20,40,0.45)]">
          {/* Day header row */}
          <div className="flex border-b border-border/70 bg-card/80 backdrop-blur">
            <div className="w-11 shrink-0 sm:w-14" aria-hidden />
            {visibleDays.map((dayIndex) => {
              const isToday = dayIndex === todayIndex;
              return (
                <div
                  key={dayIndex}
                  className="flex flex-1 items-center justify-center gap-1.5 py-2.5 sm:gap-2"
                >
                  <span
                    className={
                      isToday
                        ? "text-xs font-medium text-primary sm:text-sm"
                        : "text-xs font-medium text-muted-foreground sm:text-sm"
                    }
                  >
                    {WEEKDAY_LABELS[dayIndex]}
                  </span>
                  <span
                    className={
                      isToday
                        ? "flex size-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground sm:size-7 sm:text-sm"
                        : "text-xs font-semibold text-foreground/70 sm:text-sm"
                    }
                  >
                    {days[dayIndex].getDate()}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Time grid. */}
          <div className="relative flex h-[460px] sm:h-[540px]">
            {/* Time gutter */}
            <div className="relative w-11 shrink-0 sm:w-14">
              {HOUR_LINES.slice(0, -1).map((hour) => (
                <span
                  key={hour}
                  className="absolute right-2 -translate-y-1/2 text-[0.625rem] tabular-nums text-muted-foreground/70 sm:text-xs"
                  style={{ top: `${topPct(hour * 60)}%` }}
                >
                  {hourLabel(hour)}
                </span>
              ))}
            </div>

            {/* Day columns */}
            <div className="relative flex flex-1">
              {/* Horizontal hour lines spanning all columns */}
              <div className="pointer-events-none absolute inset-0">
                {HOUR_LINES.map((hour) => (
                  <div
                    key={hour}
                    className="absolute inset-x-0 border-t border-border/50"
                    style={{ top: `${topPct(hour * 60)}%` }}
                  />
                ))}
              </div>

              {visibleDays.map((dayIndex) => (
                <div
                  key={dayIndex}
                  className={
                    dayIndex === todayIndex
                      ? "relative flex-1 border-l border-border/50 bg-primary/[0.03] first:border-l-0"
                      : "relative flex-1 border-l border-border/50 first:border-l-0"
                  }
                >
                  {events
                    .filter((e) => e.day === dayIndex)
                    .map((event) => (
                      <MiniEvent
                        key={event.id}
                        event={event}
                        removed={removed.has(event.id)}
                      />
                    ))}

                  {/* The AI-found slot, if this is its column. */}
                  {ghost && ghost.day === dayIndex && (
                    <GhostCard slot={ghost} />
                  )}
                </div>
              ))}

              {/* Now indicator over today's column window */}
              {nowVisible && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-30"
                  style={{ top: `${topPct(nowMinutes)}%` }}
                >
                  <div className="absolute inset-x-0 h-px -translate-y-1/2 bg-red-500/25" />
                  <div
                    className="absolute h-0.5 -translate-y-1/2 bg-red-500"
                    style={{
                      left: `${(todayPos / visibleDays.length) * 100}%`,
                      width: `${(1 / visibleDays.length) * 100}%`,
                    }}
                  />
                  <div
                    className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500"
                    style={{ left: `${(todayPos / visibleDays.length) * 100}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* The qali assistant sits below the calendar as its own element. */}
        <div className="mt-8 flex flex-col items-center gap-3 px-4">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {SCENES.map((scene) => {
              const done = applied.has(scene.id);
              return (
                <button
                  key={scene.id}
                  type="button"
                  onClick={() => runScene(scene)}
                  disabled={done || busy !== null}
                  className={
                    done
                      ? "cursor-default rounded-full bg-muted px-3.5 py-1.5 text-xs font-medium text-muted-foreground/60 ring ring-black/5 sm:text-sm"
                      : "rounded-full bg-card px-3.5 py-1.5 text-xs font-medium text-foreground ring ring-black/10 shadow-sm transition hover:bg-accent disabled:opacity-50 sm:text-sm"
                  }
                >
                  {scene.prompt}
                </button>
              );
            })}
          </div>

          <div
            className="overflow-hidden rounded-full bg-primary text-primary-foreground shadow-lg ring-1 ring-black/10 transition-[width] duration-300 ease-out"
            style={pillWidth != null ? { width: pillWidth } : undefined}
          >
            <div
              ref={pillContentRef}
              className="flex w-fit items-center gap-2 whitespace-nowrap py-2 pl-3 pr-4"
            >
              <MascotSpark />
            <div className="min-w-[13rem] text-left text-sm sm:min-w-[15rem]">
              {/* A single key-remounted line: changing the key replays the CSS
                  slide-in (`feature-line-in`), so each message rises into place.
                  The whole section stays on compositor-driven CSS (transitions +
                  transform-only keyframes) rather than JS animation, so content
                  is never left invisible if animation is throttled or disabled. */}
              <span
                key={
                  busy
                    ? `busy-${busy.id}`
                    : confirmation
                      ? `done-${confirmation}`
                      : "idle"
                }
                className={
                  busy || confirmation
                    ? "feature-line-in flex items-center gap-1.5"
                    : "feature-line-in block text-primary-foreground/80"
                }
              >
                {busy ? (
                  <>
                    {busy.thinking}
                    <ThinkingDots />
                  </>
                ) : confirmation ? (
                  <>
                    <CheckIcon />
                    {confirmation}
                  </>
                ) : (
                  "Ask qali anything about your week…"
                )}
              </span>
            </div>
            {hasChanges && !busy && (
              <button
                type="button"
                onClick={reset}
                className="ml-1 rounded-full bg-primary-foreground/15 px-2.5 py-1 -my-8 -mr-2 text-xs font-medium text-primary-foreground transition hover:bg-primary-foreground/25"
              >
                Reset
              </button>
            )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** A single event card, matching the app's `.event-card` treatment. */
function MiniEvent({
  event,
  removed,
}: {
  event: PreviewEvent;
  removed: boolean;
}) {
  // Position, size, and visibility animate via plain CSS transitions rather
  // than motion: motion's `layout`/`animate` projection was overriding these
  // inline values here (a reschedule left the card stuck, a clear never faded).
  // A CSS transition on top/height/opacity/transform is fully under our control
  // and always fires on a React re-render.
  return (
    <div
      className="absolute inset-x-1 z-10 min-h-[20px] overflow-hidden rounded-lg shadow-sm ring-1 ring-border/60 inset-ring inset-ring-black/10 transition-[top,height,opacity,transform] duration-500 ease-out dark:inset-ring-white/10"
      style={{
        top: `${topPct(event.start)}%`,
        height: `${heightPct(event.start, event.end)}%`,
        opacity: removed ? 0 : 1,
        transform: removed ? "scale(0.92)" : "scale(1)",
        pointerEvents: removed ? "none" : undefined,
        backgroundColor: `color-mix(in oklab, var(${event.color}) 22%, var(--card))`,
      }}
    >
      <span
        aria-hidden
        className="absolute top-1 bottom-1 left-1 w-[3px] rounded-full"
        style={{ backgroundColor: `var(${event.color})` }}
      />
      <div className="flex h-full flex-col justify-start py-1 pr-1.5 pl-3">
        <p className="truncate text-[0.7rem] font-medium leading-tight text-foreground sm:text-xs">
          {event.title}
        </p>
        <p className="truncate text-[0.6rem] leading-tight text-muted-foreground sm:text-[0.7rem]">
          {formatRange(event.start, event.end)}
        </p>
      </div>
    </div>
  );
}

/** The AI-suggested open slot. Fades in on mount via the `feature-pop-in` CSS
 * animation (compositor-driven, so it is unaffected by rAF throttling), and
 * simply unmounts on reset. */
function GhostCard({ slot }: { slot: GhostSlot }) {
  return (
    <div
      className="feature-pop-in absolute inset-x-1 z-20 flex flex-col justify-center gap-0.5 overflow-hidden rounded-lg border-2 border-dashed border-primary/60 bg-primary/[0.08] px-2 py-1 text-left"
      style={{
        top: `${topPct(slot.start)}%`,
        height: `${heightPct(slot.start, slot.end)}%`,
      }}
    >
      <span className="text-[0.7rem] font-semibold text-primary sm:text-xs">
        {slot.label}
      </span>
      <span className="truncate text-[0.65rem] text-primary/70 sm:text-[0.7rem]">
        {formatRange(slot.start, slot.end)}
      </span>
    </div>
  );
}

/** Compact monotone mascot glyph, echoing the assistant dock's `MascotGlyph`. */
function MascotSpark() {
  return (
    <svg
      viewBox="0 0 236 236"
      className="size-5 shrink-0"
      fill="none"
      role="presentation"
      focusable="false"
    >
      <path
        d="M40 118 C36 66 74 30 122 32 C172 34 202 74 196 122 C193 147 181 158 176 176 C171 195 176 214 156 216 C141 217 137 201 128 199 C119 197 113 208 101 209 C86 210 80 197 73 180 C67 165 51 158 45 141 C41 129 40 124 40 118 Z"
        fill="currentColor"
      />
      <rect x="80" y="88" width="28" height="54" rx="14" fill="var(--primary)" />
      <rect x="128" y="92" width="28" height="54" rx="14" fill="var(--primary)" />
    </svg>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="feature-dot inline-block size-1 rounded-full bg-current"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden>
      <path
        d="M5 10.5 8.5 14 15 6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
