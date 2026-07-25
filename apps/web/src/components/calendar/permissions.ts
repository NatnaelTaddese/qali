import { api } from "@qali/backend/convex/_generated/api";
import {
  eventCapabilities,
  type EventCapabilities,
} from "@qali/backend/convex/lib/permissions";
import { useQuery } from "convex/react";
import { useCallback, useMemo } from "react";

import type { CalendarEvent } from "./lib";

export type { EventCapabilities };

/**
 * `(event) => EventCapabilities`, with the user's calendars loaded so each
 * event can be judged against the access role of the calendar it lives on.
 *
 * The rules themselves live in the backend's `lib/permissions`, which the
 * server enforces independently — this hook only decides what to *offer*.
 *
 * Modelled on `useEventColor`: the calendar list is a separate subscription
 * rather than something bolted onto the event query, so the event rows stay
 * referentially stable (the drag override and `useStableQuery` both depend on
 * that). Convex dedupes the subscription, so calling this in several places is
 * free.
 */
export function useEventCapabilities(): (
  event: CalendarEvent,
) => EventCapabilities {
  const calendars = useQuery(api.calendar.listCalendars);
  const byGoogleId = useMemo(
    () => new Map(calendars?.map((c) => [c.googleCalendarId, c])),
    [calendars],
  );
  return useCallback(
    (event: CalendarEvent) =>
      eventCapabilities(event, byGoogleId.get(event.calendarId)),
    [byGoogleId],
  );
}
