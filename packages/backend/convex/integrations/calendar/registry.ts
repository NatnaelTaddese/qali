/** Resolve one owned, active connection into its provider adapter. */

import type { GenericCtx } from "@convex-dev/better-auth";

import { internal } from "../../_generated/api";
import type { DataModel, Doc, Id } from "../../_generated/dataModel";
import { getGoogleAccessToken } from "../google/credentials";
import { GoogleCalendarAdapter } from "../google/adapter";
import type { CalendarProviderAdapter } from "./types";

export async function getCalendarAdapter(
  ctx: GenericCtx<DataModel>,
  userId: string,
  connectionId: Id<"calendarConnections">,
): Promise<CalendarProviderAdapter> {
  const connection: Doc<"calendarConnections"> | null = await ctx.runQuery(
    internal.calendar.getCalendarConnectionForAdapter,
    { userId, connectionId },
  );
  if (!connection) {
    throw new Error("Calendar connection is unavailable");
  }

  switch (connection.provider) {
    case "google": {
      const accessToken = await getGoogleAccessToken(
        ctx,
        userId,
        connection.credentialRef,
      );
      return new GoogleCalendarAdapter(accessToken);
    }
    case "microsoft":
      throw new Error("Microsoft calendar integration is not yet available");
  }
}
