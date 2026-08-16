import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

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
  if (existing) return existing._id;
  const now = Date.now();
  return await ctx.db.insert("calendarConnections", {
    userId,
    provider: "google",
    status: "active",
    capabilities: { contacts: true, idempotentCreate: true },
    createdAt: now,
    updatedAt: now,
  });
}
