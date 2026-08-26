import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { EventPrefill } from "@/components/calendar/event-create";
import {
  DEFAULT_EVENT_DURATION_MS,
  nextFreeSlot,
  type CalendarEvent,
} from "@/components/calendar/lib";
import { startOfDay } from "date-fns";
import type { Booking } from "@/components/workspace/booking-request-panel";

/** What the dock is currently showing. `null` means the plain nav bar.
 *
 * A create view keeps its range at the top level rather than inside `prefill`,
 * because the ghost on the grid reads those two fields directly. */
export type DockView =
  | { kind: "event"; event: CalendarEvent }
  | { kind: "edit"; event: CalendarEvent }
  | { kind: "create"; startMs: number; endMs: number; prefill?: EventPrefill }
  | { kind: "account" }
  | { kind: "availability" }
  | { kind: "booking"; booking: Booking };

/** Stable key for the content swap — changing it cross-fades the dock's contents.
 * A create view keys on its kind alone, so editing its times re-renders the form
 * in place (and moves the ghost on the grid) instead of replaying the swap. */
export function dockViewId(view: DockView): string {
  if (view.kind === "event") return `event:${view.event._id}`;
  if (view.kind === "edit") return `edit:${view.event._id}`;
  if (view.kind === "booking") return `booking:${view.booking._id}`;
  return view.kind;
}

/** Which way the content travels. Stepping between two events moves along time:
 * a later event slides in from the right, an earlier one from the left. Any
 * other change is a kind swap, which fades on y instead. */
function slideDirection(prev: DockView | null, next: DockView): number {
  if (prev?.kind !== "event" || next.kind !== "event") return 0;
  return Math.sign(next.event.startMs - prev.event.startMs);
}

/** How the calendar seeds a new event: the day it's currently showing plus the
 * timed events on it, so the dock can land "create" on the next free slot. */
type CreateSeed = { dayStartMs: number; events: CalendarEvent[] };

/** A request to scroll the calendar to an item and pulse it. `startMs` locates
 * the day/time to scroll to (omitted for an item with no time — it only pulses
 * if already on screen); `flashId` is the item's reveal key (an event `_id` or
 * `providerEventId`, or a booking `_id`). */
export type RevealInput = { startMs?: number; flashId: string };

interface DockContextValue {
  view: DockView | null;
  viewId: string | null;
  /** -1, 0 or 1 — passed to the content variants as `custom`. */
  direction: number;
  open: (view: DockView) => void;
  close: () => void;
  /** The calendar registers the day it's focused on (and that day's events) so
   * the dock's Create button can seed a new event there. Pass `null` to clear. */
  registerCreateSeed: (seed: CreateSeed | null) => void;
  /** Open a create view on the registered day's next free 30-min slot, falling
   * back to the next slot from now when the calendar hasn't registered one. */
  openCreate: () => void;
  /** The calendar registers how to scroll-and-pulse an item; pass `null` to
   * clear. Others (notification feed, assistant proposals) call `reveal`. */
  registerReveal: (fn: ((input: RevealInput) => void) | null) => void;
  /** Scroll the calendar to an item and pulse it. A no-op until the calendar
   * has mounted and registered a handler. */
  reveal: (input: RevealInput) => void;
}

const DockContext = createContext<DockContextValue | null>(null);

export function DockProvider({ children }: { children: ReactNode }) {
  // View and direction move together so the exiting and entering content always
  // agree on which way they are travelling.
  const [state, setState] = useState<{ view: DockView | null; direction: number }>({
    view: null,
    direction: 0,
  });

  const open = useCallback((next: DockView) => {
    setState((prev) => ({ view: next, direction: slideDirection(prev.view, next) }));
  }, []);

  const close = useCallback(() => setState({ view: null, direction: 0 }), []);

  // A ref, not state: the calendar re-registers on every scroll settle, and the
  // Create button only reads it on click — no render needs to track it.
  const createSeedRef = useRef<CreateSeed | null>(null);
  const registerCreateSeed = useCallback((seed: CreateSeed | null) => {
    createSeedRef.current = seed;
  }, []);

  const openCreate = useCallback(() => {
    const seed = createSeedRef.current;
    const dayStartMs = seed?.dayStartMs ?? startOfDay(Date.now()).getTime();
    const range = nextFreeSlot(
      dayStartMs,
      seed?.events ?? [],
      Date.now(),
      DEFAULT_EVENT_DURATION_MS,
    );
    open({ kind: "create", ...range });
  }, [open]);

  // A ref, like the create seed: the calendar registers on mount and callers
  // only read it when they fire, so no render needs to track it.
  const revealRef = useRef<((input: RevealInput) => void) | null>(null);
  const registerReveal = useCallback(
    (fn: ((input: RevealInput) => void) | null) => {
      revealRef.current = fn;
    },
    [],
  );
  const reveal = useCallback((input: RevealInput) => {
    revealRef.current?.(input);
  }, []);

  const value = useMemo<DockContextValue>(
    () => ({
      view: state.view,
      viewId: state.view ? dockViewId(state.view) : null,
      direction: state.direction,
      open,
      close,
      registerCreateSeed,
      openCreate,
      registerReveal,
      reveal,
    }),
    [state, open, close, registerCreateSeed, openCreate, registerReveal, reveal],
  );

  return <DockContext value={value}>{children}</DockContext>;
}

export function useDock(): DockContextValue {
  const ctx = useContext(DockContext);
  if (!ctx) throw new Error("useDock must be used within a DockProvider");
  return ctx;
}
