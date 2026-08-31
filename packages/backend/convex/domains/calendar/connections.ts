import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

export function connectionSyncFields(): Omit<
  Doc<"connectionSyncState">,
  "_id" | "_creationTime" | "connectionId" | "userId"
> {
  return {
    status: "idle",
    nextSyncDueAt: 0,
    syncIntervalMs: 15 * 60 * 1000,
  };
}

/** Ensure the connection's operational state exists in the same transaction.
 * A new connection begins with clean cursors and generations so it never skips
 * its first provider snapshot. */
export async function ensureConnectionSyncState(
  ctx: MutationCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
): Promise<Id<"connectionSyncState">> {
  const existing = await ctx.db
    .query("connectionSyncState")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .unique();
  if (existing) return existing._id;
  return await ctx.db.insert("connectionSyncState", {
    connectionId,
    userId,
    ...connectionSyncFields(),
  });
}

/**
 * Find (or lazily create) the user's single Google calendar connection.
 *
 * Connection == the login grant in v1, so the credential is still resolved
 * through Better Auth — this row only carries the neutral provider identity and
 * capabilities. Reused by the backfill and every dual-write path, so a user the
 * backfill missed (or who signed up since) still gets a connection on their next
 * write or sync. Idempotent: one Google connection per user.
 */
export async function ensureGoogleConnection(
  ctx: MutationCtx,
  userId: string,
): Promise<Id<"calendarConnections">> {
  const existing = await ctx.db
    .query("calendarConnections")
    .withIndex("by_user_and_provider", (q) =>
      q.eq("userId", userId).eq("provider", "google"),
    )
    .first();
  if (existing) {
    await ensureConnectionSyncState(ctx, userId, existing._id);
    return existing._id;
  }
  const now = Date.now();
  const connectionId = await ctx.db.insert("calendarConnections", {
    userId,
    provider: "google",
    status: "active",
    capabilities: { contacts: true, idempotentCreate: true },
    createdAt: now,
    updatedAt: now,
  });
  await ensureConnectionSyncState(ctx, userId, connectionId);
  return connectionId;
}

/** The deterministic "primary account" among a user's connections: active
 * first, Google before Microsoft, then the oldest — so the login grant keeps
 * winning after a second account is linked. Every default-target choice
 * (event create, booking adoption) must go through this one ordering. */
export function preferredConnection(
  connections: Doc<"calendarConnections">[],
): Doc<"calendarConnections"> | undefined {
  return connections
    .filter((row) => row.status === "active")
    .sort(
      (a, b) =>
        Number(b.provider === "google") - Number(a.provider === "google") ||
        a.createdAt - b.createdAt ||
        a._creationTime - b._creationTime,
    )[0];
}

/** A provider's `primary` alias is writable before CalendarList has synced. */
export async function ensureDefaultPrimaryCalendar(
  ctx: MutationCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
): Promise<Doc<"calendars">> {
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(501);
  if (calendars.length > 500) {
    throw new Error("Too many calendars to choose a write target safely");
  }
  const existing =
    calendars.find(
      (row) => row.primary && row.connectionId === connectionId,
    ) ??
    calendars.find(
      (row) =>
        row.providerCalendarId === "primary" &&
        row.connectionId === connectionId,
    );
  if (existing) return existing;
  const id = await ctx.db.insert("calendars", {
    userId,
    selected: true,
    primary: true,
    accessRole: "owner",
    connectionId,
    providerCalendarId: "primary",
    isShared: false,
  });
  return (await ctx.db.get(id))!;
}
