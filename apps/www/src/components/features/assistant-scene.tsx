import { cn } from "@qali/ui/lib/utils";
import { useEffect, useRef, useState } from "react";

import {
  ASSISTANT_DAYS,
  deriveGrid,
  SCENES,
  sceneById,
  useWeekDays,
  type Scene,
  type SceneId,
} from "./lib";
import {
  CheckIcon,
  GhostCard,
  MascotSpark,
  MiniEvent,
  MiniGrid,
  ThinkingDots,
} from "./parts";
import { useLoop } from "./use-loop";

/**
 * The big cell: a slice of the week view with the assistant working on it.
 *
 * Left alone it loops through the three scenes on its own — think, apply,
 * think, apply — so the cell tells its story without a click. The prompt chips
 * are still live: a click takes the cell into manual mode, runs that scene
 * the way the old section did, and a Reset (or ten idle seconds) hands it
 * back to the loop. Both modes render through `deriveGrid`, so there is one
 * grid and one set of transitions.
 */

interface AssistantState {
  applied: ReadonlySet<SceneId>;
  busy: Scene | null;
  confirmation: string | null;
}

const IDLE: AssistantState = {
  applied: new Set(),
  busy: null,
  confirmation: null,
};

type Phase =
  | { kind: "idle"; ms: number }
  | { kind: "think" | "done"; scene: SceneId; ms: number };

const AUTO_PHASES: readonly Phase[] = [
  { kind: "idle", ms: 1800 },
  { kind: "think", scene: "move", ms: 1000 },
  { kind: "done", scene: "move", ms: 2200 },
  { kind: "think", scene: "find", ms: 1000 },
  { kind: "done", scene: "find", ms: 2200 },
  { kind: "think", scene: "clear", ms: 1000 },
  { kind: "done", scene: "clear", ms: 2800 },
];
const AUTO_DURATIONS = AUTO_PHASES.map((p) => p.ms);

/** How long a clicked scene "thinks" before it lands. */
const MANUAL_BEAT_MS = 950;
/** Idle time after the last click before the loop takes over again. */
const MANUAL_IDLE_MS = 10_000;

/** The state the auto loop is showing at a given step: everything applied so
 * far, plus whichever scene is mid-thought. Pure, so it needs no effects. */
export function autoStateAt(step: number): AssistantState {
  const applied = new Set<SceneId>();
  let busy: Scene | null = null;
  let confirmation: string | null = null;
  for (let i = 1; i <= step && i < AUTO_PHASES.length; i++) {
    const phase = AUTO_PHASES[i];
    if (phase.kind === "think") {
      busy = sceneById(phase.scene);
      confirmation = null;
    } else if (phase.kind === "done") {
      applied.add(phase.scene);
      busy = null;
      confirmation = sceneById(phase.scene).confirmation;
    }
  }
  return { applied, busy, confirmation };
}

export function AssistantScene({ playing }: { playing: boolean }) {
  const { days, todayIndex } = useWeekDays();
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [manual, setManual] = useState<AssistantState>(IDLE);
  const { step, reset } = useLoop(AUTO_DURATIONS, playing && mode === "auto");
  const view = mode === "auto" ? autoStateAt(step) : manual;
  const grid = deriveGrid(view.applied);

  // The pill's width is intrinsic (message length + the Reset button toggling),
  // and `auto` widths don't transition. Measure the content's natural width and
  // drive the shell's explicit `width` from it, so it can tween between states.
  const pillContentRef = useRef<HTMLDivElement>(null);
  const [pillWidth, setPillWidth] = useState<number>();
  useEffect(() => {
    const el = pillContentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setPillWidth(Math.ceil(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const beatRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (beatRef.current !== null) window.clearTimeout(beatRef.current);
    },
    [],
  );

  function runScene(scene: Scene) {
    // While the loop runs, every chip is live: a click takes over from a clean
    // week (the cards transition back) and plays that scene. In manual mode
    // a chip that has already run, or a scene in flight, stays put.
    if (mode === "manual" && (manual.busy || manual.applied.has(scene.id))) {
      return;
    }
    if (beatRef.current !== null) window.clearTimeout(beatRef.current);
    setMode("manual");
    setManual((prev) => ({
      applied: mode === "auto" ? new Set() : prev.applied,
      busy: scene,
      confirmation: null,
    }));
    beatRef.current = window.setTimeout(() => {
      beatRef.current = null;
      setManual((prev) => ({
        applied: new Set(prev.applied).add(scene.id),
        busy: null,
        confirmation: scene.confirmation,
      }));
    }, MANUAL_BEAT_MS);
  }

  function resetAll() {
    setManual(IDLE);
    setMode("auto");
    reset();
  }

  // An abandoned cell goes back to looping on its own.
  useEffect(() => {
    if (mode !== "manual" || manual.busy) return;
    const id = window.setTimeout(resetAll, MANUAL_IDLE_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, manual]);

  const hasChanges = view.applied.size > 0;

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {SCENES.map((scene) => {
          const done = mode === "manual" && manual.applied.has(scene.id);
          return (
            <button
              key={scene.id}
              type="button"
              onClick={() => runScene(scene)}
              disabled={done || (mode === "manual" && manual.busy !== null)}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-ring",
                done
                  ? "cursor-default bg-muted text-muted-foreground/60 ring ring-black/5"
                  : "bg-background text-foreground shadow-sm ring ring-black/10 hover:bg-accent disabled:opacity-50",
              )}
            >
              {scene.prompt}
            </button>
          );
        })}
      </div>

      <MiniGrid
        days={ASSISTANT_DAYS}
        dates={days}
        todayIndex={todayIndex}
        className="h-72 sm:h-80"
      >
        {(dayIndex) => (
          <>
            {grid.events
              .filter((e) => e.day === dayIndex)
              .map((event) => (
                <MiniEvent
                  key={event.id}
                  event={event}
                  removed={grid.removed.has(event.id)}
                />
              ))}
            {grid.ghost && grid.ghost.day === dayIndex && (
              <GhostCard slot={grid.ghost} />
            )}
          </>
        )}
      </MiniGrid>

      <div className="mt-3 flex justify-center">
        <div
          className="overflow-hidden rounded-full bg-primary text-primary-foreground shadow-lg ring-1 ring-black/10 transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={pillWidth != null ? { width: pillWidth } : undefined}
        >
          <div
            ref={pillContentRef}
            className="flex w-fit items-center gap-2 whitespace-nowrap py-1.5 pl-2.5 pr-3.5"
          >
            <MascotSpark className="size-4" />
            <div
              role="status"
              aria-live={mode === "manual" ? "polite" : "off"}
              className="min-w-[12rem] text-left text-xs sm:min-w-[14rem] sm:text-sm"
            >
              {/* A single key-remounted line: changing the key replays the CSS
                  slide-in, so each message rises into place. */}
              <span
                key={
                  view.busy
                    ? `busy-${view.busy.id}`
                    : view.confirmation
                      ? `done-${view.confirmation}`
                      : "idle"
                }
                className={cn(
                  "feature-line-in flex items-center gap-1.5",
                  !view.busy && !view.confirmation && "text-primary-foreground/80",
                )}
              >
                {view.busy ? (
                  <>
                    {view.busy.thinking}
                    <ThinkingDots />
                  </>
                ) : view.confirmation ? (
                  <>
                    <CheckIcon />
                    {view.confirmation}
                  </>
                ) : (
                  "Ask qali anything about your week…"
                )}
              </span>
            </div>
            {mode === "manual" && hasChanges && !view.busy && (
              <button
                type="button"
                onClick={resetAll}
                className="-my-8 -mr-1.5 ml-1 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-xs font-medium text-primary-foreground outline-none transition hover:bg-primary-foreground/25 focus-visible:ring-2 focus-visible:ring-primary-foreground/50"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
