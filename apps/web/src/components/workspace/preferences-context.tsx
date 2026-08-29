import { api } from "@qali/backend/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import {
  WEEK_STARTS_ON,
  type CalendarView,
  type WeekStart,
} from "@/components/calendar/lib";
import { useStableQuery } from "@/components/calendar/use-stable-query";
import { WorkspaceSkeleton } from "./workspace-skeleton";

type RawPreferences = NonNullable<
  FunctionReturnType<typeof api.domains.preferences.queries.getMyPreferences>
>;

/** Stored preferences resolved to usable values: every "automatic" (absent)
 * field is replaced by its default — the browser zone, or the app's own. */
interface PreferencesValue {
  weekStartsOn: WeekStart;
  use24h: boolean;
  defaultView: CalendarView;
  /** The zone the booking page's hours are published in. Event writes and
   * grid rendering deliberately stay in the browser's zone — event times are
   * composed in browser-local wall clock, and a different anchor would drift
   * recurrences (see the note by TIMEZONES in calendar/lib.ts). */
  timeZone: string;
  defaultCalendarId: RawPreferences["defaultCalendarId"];
  /** The stored fields as-is, for UI that distinguishes "automatic" from set. */
  raw: RawPreferences;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

/** Everything "automatic": the fallback when nothing is stored or readable. */
const EMPTY_RAW: RawPreferences = {
  timeZone: undefined,
  weekStartsOn: undefined,
  timeFormat: undefined,
  defaultView: undefined,
  defaultCalendarId: undefined,
};

function resolve(raw: RawPreferences): PreferencesValue {
  return {
    weekStartsOn: raw.weekStartsOn ?? WEEK_STARTS_ON,
    use24h: raw.timeFormat === "24h",
    defaultView: raw.defaultView ?? "week",
    timeZone: raw.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    defaultCalendarId: raw.defaultCalendarId,
    raw,
  };
}

/**
 * Loads the user's preferences once for the workspace. The very first paint
 * waits for the query (piggybacking on the auth-loading skeleton moment) so
 * the calendar mounts with the right default view and week shape. After that
 * the workspace NEVER unmounts on this query: a transient `null` (the query
 * evaluating during an auth-token blip while <Authenticated> still renders)
 * keeps the last resolved value, and a `null` with nothing to fall back on
 * renders the defaults rather than hanging on a skeleton forever.
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const raw = useStableQuery(api.domains.preferences.queries.getMyPreferences);
  const lastValue = useRef<PreferencesValue | null>(null);

  const value = useMemo<PreferencesValue | null>(
    () => (raw === undefined || raw === null ? null : resolve(raw)),
    [raw],
  );
  if (value) lastValue.current = value;
  const effective = value ?? lastValue.current;

  if (!effective && raw === undefined) return <WorkspaceSkeleton />;
  return (
    <PreferencesContext value={effective ?? resolve(EMPTY_RAW)}>
      {children}
    </PreferencesContext>
  );
}

export function usePreferences(): PreferencesValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    throw new Error("usePreferences must be used within a PreferencesProvider");
  }
  return ctx;
}
