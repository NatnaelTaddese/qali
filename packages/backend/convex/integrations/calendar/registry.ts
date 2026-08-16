/**
 * Selects the calendar adapter for a request. Today there is one provider and
 * one credential — the user's Google login grant — so this always returns a
 * token-bound GoogleCalendarAdapter resolved through the credential broker.
 *
 * When the connection model lands, `getCalendarAdapter` takes a connection (or
 * its id), reads `connection.provider`, and resolves that connection's
 * credential — the only place that has to change to make CRUD multi-provider.
 */

import type { GenericCtx } from "@convex-dev/better-auth";

import type { DataModel } from "../../_generated/dataModel";
import { getGoogleAccessToken } from "../google/credentials";
import { GoogleCalendarAdapter } from "../google/adapter";
import type { CalendarProviderAdapter, ProviderId } from "./types";

export async function getCalendarAdapter(
  ctx: GenericCtx<DataModel>,
  userId: string,
  provider: ProviderId = "google",
): Promise<CalendarProviderAdapter> {
  switch (provider) {
    case "google": {
      const accessToken = await getGoogleAccessToken(ctx, userId);
      return new GoogleCalendarAdapter(accessToken);
    }
    case "microsoft":
      throw new Error("Microsoft calendar integration is not yet available");
  }
}
