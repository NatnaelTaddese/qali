/** Resolve one owned, active connection into its provider adapter. */

import type { GenericCtx } from "@convex-dev/better-auth";

import { internal } from "../../_generated/api";
import type { DataModel, Doc, Id } from "../../_generated/dataModel";
import { getGoogleAccessToken } from "../google/credentials";
import { GoogleCalendarAdapter } from "../google/adapter";
import { GoogleContactsAdapter } from "../google/contactsAdapter";
import type { ContactsProviderAdapter } from "./contacts";
import type { CalendarProviderAdapter } from "./types";

async function connectionForAdapter(
  ctx: GenericCtx<DataModel>,
  userId: string,
  connectionId: Id<"calendarConnections">,
): Promise<Doc<"calendarConnections">> {
  const connection: Doc<"calendarConnections"> | null = await ctx.runQuery(
    internal.domains.calendar.queries.getCalendarConnectionForAdapter,
    { connectionId, userId },
  );
  if (!connection) {
    throw new Error("Calendar connection is unavailable");
  }
  return connection;
}

/** Adapter for a connection document already in hand, so a caller holding the
 * doc pays no extra lookup. The doc must come from
 * `getCalendarConnectionForAdapter`, which is what enforces ownership and
 * active status. */
export async function calendarAdapterFor(
  ctx: GenericCtx<DataModel>,
  connection: Doc<"calendarConnections">,
): Promise<CalendarProviderAdapter> {
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

export async function getCalendarAdapter(
  ctx: GenericCtx<DataModel>,
  userId: string,
  connectionId: Id<"calendarConnections">,
): Promise<CalendarProviderAdapter> {
  return await calendarAdapterFor(
    ctx,
    await connectionForAdapter(ctx, userId, connectionId),
  );
}

/** Contacts variant of `calendarAdapterFor`; null when the connection has no
 * contacts capability. Only fetches a token when it will build an adapter. */
export async function contactsAdapterFor(
  ctx: GenericCtx<DataModel>,
  connection: Doc<"calendarConnections">,
): Promise<ContactsProviderAdapter | null> {
  if (!connection.capabilities?.contacts) return null;
  // The user's own switch, distinct from the provider capability above.
  if (connection.contactsSyncEnabled === false) return null;

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

export async function getContactsAdapter(
  ctx: GenericCtx<DataModel>,
  userId: string,
  connectionId: Id<"calendarConnections">,
): Promise<ContactsProviderAdapter | null> {
  return await contactsAdapterFor(
    ctx,
    await connectionForAdapter(ctx, userId, connectionId),
  );
}
