import { api } from "@qali/backend/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { createContext, useContext, useMemo, type ReactNode } from "react";

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
  /** The zone for new events and the booking page. Grid rendering stays in the
   * browser's zone — see the note by TIMEZONES in calendar/lib.ts. */
  timeZone: string;
  defaultCalendarId: RawPreferences["defaultCalendarId"];
  /** The stored fields as-is, for UI that distinguishes "automatic" from set. */
  raw: RawPreferences;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

/**
 * Loads the user's preferences once for the workspace. The first paint waits
 * for them (piggybacking on the auth-loading skeleton moment) so the calendar
 * mounts with the right default view and week shape; after that,
 * `useStableQuery` keeps renders warm across reconnects.
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const raw = useStableQuery(api.domains.preferences.queries.getMyPreferences);

  const value = useMemo<PreferencesValue | null>(() => {
    if (raw === undefined || raw === null) return null;
    return {
      weekStartsOn: raw.weekStartsOn ?? WEEK_STARTS_ON,
      use24h: raw.timeFormat === "24h",
      defaultView: raw.defaultView ?? "week",
      timeZone:
        raw.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      defaultCalendarId: raw.defaultCalendarId,
      raw,
    };
  }, [raw]);

  if (!value) return <WorkspaceSkeleton />;
  return <PreferencesContext value={value}>{children}</PreferencesContext>;
}

export function usePreferences(): PreferencesValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    throw new Error("usePreferences must be used within a PreferencesProvider");
  }
  return ctx;
}
