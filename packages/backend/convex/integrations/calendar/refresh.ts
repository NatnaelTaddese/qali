/** Transitional provider-neutral seam for re-expanding recurring writes. */

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { CALENDAR_HISTORY_MS, syncOneCalendar } from "../../googleSync";
import { getGoogleAccessToken } from "../google/credentials";

/**
 * The existing sync engine remains authoritative for recurrence expansion.
 * Calendar-domain code calls this neutral identity seam; provider dispatch and
 * the temporary Google bridge stay in the integration layer until the sync
 * engine itself is moved onto CalendarProviderAdapter.
 */
export async function refreshCalendarMirror(
  ctx: ActionCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
  localCalendarId: Id<"calendars">,
): Promise<void> {
  const connection = await ctx.runQuery(
    internal.calendar.getCalendarConnectionForAdapter,
    { userId, connectionId },
  );
  const calendars = await ctx.runQuery(internal.googleSync.listCalendarsForUser, {
    userId,
  });
  const calendar = calendars.find((row) => row._id === localCalendarId);
  if (!connection || !calendar || calendar.connectionId !== connectionId) {
    throw new Error("Calendar refresh target is unavailable");
  }

  switch (connection.provider) {
    case "google": {
      const accessToken = await getGoogleAccessToken(
        ctx,
        userId,
        connection.credentialRef,
      );
      await syncOneCalendar(
        ctx,
        userId,
        accessToken,
        {
          googleCalendarId: calendar.googleCalendarId,
          syncToken: calendar.syncToken,
        },
        Date.now() - CALENDAR_HISTORY_MS,
      );
      return;
    }
    case "microsoft":
      throw new Error("Microsoft calendar sync is not yet available");
  }
}
