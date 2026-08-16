import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

export function connectionSyncFields(
  legacy: Doc<"syncState"> | null,
): Omit<
  Doc<"connectionSyncState">,
  "_id" | "_creationTime" | "connectionId" | "userId"
> {
  return {
    contactsCursor: legacy?.contactsSyncToken,
    otherContactsCursor: legacy?.otherContactsSyncToken,
    contactsLastSyncedAt: legacy?.lastContactsSyncAt,
    otherContactsLastSyncedAt: legacy?.lastOtherContactsSyncAt,
    contactsGeneration: legacy?.contactsSyncGeneration,
    otherContactsGeneration: legacy?.otherContactsSyncGeneration,
    status: legacy?.status ?? "idle",
    lastError: legacy?.lastError,
    nextSyncDueAt: legacy?.nextSyncDueAt ?? 0,
    syncIntervalMs: legacy?.syncIntervalMs ?? 15 * 60 * 1000,
    syncLeaseExpiresAt: legacy?.syncLeaseExpiresAt,
    syncAttemptId: legacy?.syncAttemptId,
  };
}

/** Ensure the connection's operational state exists in the same transaction. */
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
  const legacy = await ctx.db
    .query("syncState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return await ctx.db.insert("connectionSyncState", {
    connectionId,
    userId,
    ...connectionSyncFields(legacy),
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
