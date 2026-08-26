import { api } from "@qali/backend/convex/_generated/api";
import type { Doc, Id } from "@qali/backend/convex/_generated/dataModel";
import {
  type DayInterval,
  mergeDayIntervals,
} from "@qali/domain/availability";
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { MS_PER_MINUTE } from "@/components/calendar/lib";

/** A day's availability span with its live save state, so the grid can shimmer a
 * block that is still being written and paint it solid once it lands. */
export interface RenderInterval extends DayInterval {
  saving: boolean;
}

/** A day's effective availability, and whether it comes from a per-date override
 * (painted by hand) or is still inherited from the weekly rules. */
export interface DayAvailability {
  intervals: RenderInterval[];
  isOverride: boolean;
}

interface AvailabilityEditValue {
  /** Whether the calendar is in availability-painting mode. */
  editing: boolean;
  setEditing: (editing: boolean) => void;
  /** Both schedule queries have resolved, so edits have a complete base. */
  ready: boolean;
  /** The effective availability for a day (override intervals, else weekly). */
  intervalsForDay: (day: Date) => DayAvailability;
  /** Paint a new availability span onto a day, snapped ms in, saved at once. */
  addInterval: (day: Date, startMs: number, endMs: number) => void;
  /** Remove the interval at `index` from a day; an empty result blocks the day. */
  removeInterval: (day: Date, index: number) => void;
  /** Drop the day's override and hand it back to the weekly rules. */
  resetDay: (day: Date) => void;
}

const AvailabilityEditContext = createContext<AvailabilityEditValue | null>(
  null,
);

const NO_ARGS = {} as const;

/** `dateKey` as the day reads locally — matches the page's own zone, which
 * `upsertBookingPage` sets from this same browser. */
function dayKey(day: Date): string {
  return format(day, "yyyy-MM-dd");
}

/** Stable id for an interval's save state, unique within the day. */
function savingId(dateKey: string, interval: DayInterval): string {
  return `${dateKey}:${interval.startMin}-${interval.endMin}`;
}

/** Weekly openings for a weekday, as a day's intervals in ascending order. */
function weeklyIntervals(
  rules: Doc<"bookingPages">["rules"],
  weekday: number,
): DayInterval[] {
  return rules
    .filter((rule) => rule.weekday === weekday)
    .map((rule) => ({ startMin: rule.startMin, endMin: rule.endMin }))
    .sort((a, b) => a.startMin - b.startMin);
}

export function AvailabilityEditProvider({ children }: { children: ReactNode }) {
  const [editing, setEditingState] = useState(false);
  // Interval save-state ids currently in flight, so their blocks shimmer.
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());

  // The override write reflects into the local query at once, so a painted
  // block appears the instant it's drawn instead of after the round trip; the
  // real result reconciles it with no flicker.
  const setOverride = useMutation(api.domains.booking.mutations.setOverride).withOptimisticUpdate(
    (store, { dateKey, intervals }) => {
      const existing = store.getQuery(api.domains.booking.queries.listMyOverrides, NO_ARGS);
      if (existing === undefined) return;
      const without = existing.filter((o) => o.dateKey !== dateKey);
      if (intervals === undefined) {
        store.setQuery(api.domains.booking.queries.listMyOverrides, NO_ARGS, without);
        return;
      }
      const prior = existing.find((o) => o.dateKey === dateKey);
      const doc: Doc<"availabilityOverrides"> = {
        _id: prior?._id ?? (`optimistic:${dateKey}` as Id<"availabilityOverrides">),
        _creationTime: prior?._creationTime ?? Date.now(),
        userId: prior?.userId ?? "",
        dateKey,
        intervals,
      };
      store.setQuery(api.domains.booking.queries.listMyOverrides, NO_ARGS, [...without, doc]);
    },
  );

  // Only live while painting: the grid is inert to availability otherwise.
  const page = useQuery(api.domains.booking.queries.getMyBookingPage, editing ? NO_ARGS : "skip");
  const overrides = useQuery(
    api.domains.booking.queries.listMyOverrides,
    editing ? NO_ARGS : "skip",
  );

  const overrideByDate = useMemo(() => {
    const map = new Map<string, DayInterval[]>();
    for (const o of overrides ?? []) map.set(o.dateKey, o.intervals);
    return map;
  }, [overrides]);

  const rules = page?.rules ?? [];
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ready =
    page !== undefined &&
    page !== null &&
    page.timeZone === browserTimeZone &&
    overrides !== undefined;

  const intervalsForDay = useCallback(
    (day: Date): DayAvailability => {
      const key = dayKey(day);
      const override = overrideByDate.get(key);
      const base = override ?? weeklyIntervals(rules, day.getDay());
      const intervals = base.map((interval) => ({
        ...interval,
        saving: saving.has(savingId(key, interval)),
      }));
      return { intervals, isOverride: override !== undefined };
    },
    [overrideByDate, rules, saving],
  );

  const markSaving = useCallback((id: string, on: boolean) => {
    setSaving((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const commit = useCallback(
    async (
      day: Date,
      intervals: DayInterval[] | undefined,
      savingKey: string | null,
    ) => {
      try {
        await setOverride(
          intervals === undefined
            ? { dateKey: dayKey(day) }
            : { dateKey: dayKey(day), intervals },
        );
      } catch (error: unknown) {
        toast.error("Couldn't save availability", {
          description: error instanceof Error ? error.message : undefined,
        });
      } finally {
        if (savingKey) markSaving(savingKey, false);
      }
    },
    [setOverride, markSaving],
  );

  const addInterval = useCallback(
    (day: Date, startMs: number, endMs: number) => {
      const dayStartMs = day.getTime();
      const startMin = Math.round((startMs - dayStartMs) / MS_PER_MINUTE);
      const endMin = Math.round((endMs - dayStartMs) / MS_PER_MINUTE);
      if (endMin <= startMin) return;
      const key = dayKey(day);
      const next = mergeDayIntervals([
        ...intervalsForDay(day).intervals,
        { startMin, endMin },
      ]);
      // Shimmer the merged block that swallowed the new span until it lands.
      const landed =
        next.find((i) => i.startMin <= startMin && i.endMin >= endMin) ??
        ({ startMin, endMin } as DayInterval);
      const id = savingId(key, landed);
      markSaving(id, true);
      void commit(day, next, id);
    },
    [intervalsForDay, markSaving, commit],
  );

  const removeInterval = useCallback(
    (day: Date, index: number) => {
      const next = intervalsForDay(day)
        .intervals.filter((_, i) => i !== index)
        .map(({ startMin, endMin }) => ({ startMin, endMin }));
      void commit(day, next, null);
    },
    [intervalsForDay, commit],
  );

  const resetDay = useCallback(
    (day: Date) => {
      void commit(day, undefined, null);
    },
    [commit],
  );

  const value = useMemo<AvailabilityEditValue>(
    () => ({
      editing,
      setEditing: setEditingState,
      ready,
      intervalsForDay,
      addInterval,
      removeInterval,
      resetDay,
    }),
    [editing, ready, intervalsForDay, addInterval, removeInterval, resetDay],
  );

  return (
    <AvailabilityEditContext value={value}>{children}</AvailabilityEditContext>
  );
}

export function useAvailabilityEdit(): AvailabilityEditValue {
  const ctx = useContext(AvailabilityEditContext);
  if (!ctx) {
    throw new Error(
      "useAvailabilityEdit must be used within an AvailabilityEditProvider",
    );
  }
  return ctx;
}
