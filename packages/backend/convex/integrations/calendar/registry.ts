/** Resolve one owned, active connection into its provider adapter. */

import type { GenericCtx } from "@convex-dev/better-auth";

import { internal } from "../../_generated/api";
import type { DataModel, Doc, Id } from "../../_generated/dataModel";
import { getGoogleAccessToken } from "../google/credentials";
import { GoogleCalendarAdapter } from "../google/adapter";
import { GoogleContactsAdapter } from "../google/contactsAdapter";
import type { ContactsProviderAdapter } from "./contacts";
import type { CalendarProviderAdapter } from "./types";

export async function getCalendarAdapter(
  ctx: GenericCtx<DataModel>,
  connectionId: Id<"calendarConnections">,
): Promise<CalendarProviderAdapter> {
  const connection: Doc<"calendarConnections"> | null = await ctx.runQuery(
    internal.calendar.getCalendarConnectionForAdapter,
    { connectionId },
  );
  if (!connection) {
    throw new Error("Calendar connection is unavailable");
  }

  switch (connection.provider) {
    case "google": {
      const accessToken = await getGoogleAccessToken(
        ctx,
        connection.userId,
        connection.credentialRef,
      );
      return new GoogleCalendarAdapter(accessToken);
    }
    case "microsoft":
      throw new Error("Microsoft calendar integration is not yet available");
  }
}

export async function getContactsAdapter(
  ctx: GenericCtx<DataModel>,
  connectionId: Id<"calendarConnections">,
): Promise<ContactsProviderAdapter | null> {
  const connection: Doc<"calendarConnections"> | null = await ctx.runQuery(
    internal.calendar.getCalendarConnectionForAdapter,
    { connectionId },
  );
  if (!connection) throw new Error("Calendar connection is unavailable");
  if (!connection.capabilities?.contacts) return null;

  switch (connection.provider) {
    case "google":
      return new GoogleContactsAdapter(
        await getGoogleAccessToken(
          ctx,
          connection.userId,
          connection.credentialRef,
        ),
      );
    case "microsoft":
      return null;
  }
}
