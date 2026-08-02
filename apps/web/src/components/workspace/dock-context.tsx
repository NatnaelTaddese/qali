import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { EventPrefill } from "@/components/calendar/event-create";
import type { CalendarEvent } from "@/components/calendar/lib";
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
  | { kind: "booking"; booking: Booking }
  // The island holds the assistant thread outside the view: putting it here
  // would change the view id when the first message creates a thread and replay
  // the panel swap in the middle of the reply.
  | { kind: "assistant" };

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

interface DockContextValue {
  view: DockView | null;
  viewId: string | null;
  /** -1, 0 or 1 — passed to the content variants as `custom`. */
  direction: number;
  open: (view: DockView) => void;
  close: () => void;
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

  const value = useMemo<DockContextValue>(
    () => ({
      view: state.view,
      viewId: state.view ? dockViewId(state.view) : null,
      direction: state.direction,
      open,
      close,
    }),
    [state, open, close],
  );

  return <DockContext value={value}>{children}</DockContext>;
}

export function useDock(): DockContextValue {
  const ctx = useContext(DockContext);
  if (!ctx) throw new Error("useDock must be used within a DockProvider");
  return ctx;
}
