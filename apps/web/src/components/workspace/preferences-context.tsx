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
  /** The WORKING zone: the calendar renders, composes, and labels every
   * time in it — day cuts, gutter hours, wheel pickers, event writes, the
   * booking page's hours, and assistant date resolution. Defaults to the
   * browser's zone when no preference is stored. */
  timeZone: string;
  defaultCalendarId: RawPreferences["defaultCalendarId"];
  /** The stored fields as-is, for UI that distinguishes "automatic" from set. */
  raw: RawPreferences;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

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
 * waits for the query to resolve to a real row (both `undefined` while loading
 * and the transient `null` while the auth token attaches — the backend only
 * returns `null` for "no identity", never for "no stored row"), so the
 * calendar never mounts in the browser zone and then flips to the working
 * zone. After that first resolution the workspace NEVER unmounts on this
 * query: a later `null` (an auth-token blip while <Authenticated> still
 * renders) keeps the last resolved value.
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

  if (!effective) return <WorkspaceSkeleton />;
  return <PreferencesContext value={effective}>{children}</PreferencesContext>;
}

export function usePreferences(): PreferencesValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    throw new Error("usePreferences must be used within a PreferencesProvider");
  }
  return ctx;
}
