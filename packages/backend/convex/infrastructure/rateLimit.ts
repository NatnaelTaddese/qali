import type { MutationCtx } from "../_generated/server";

/**
 * Fixed-window rate-limit counter over the `bookingRateLimits` table, shared by
 * every anonymous surface (booking requests, waitlist signups). Returns `false`
 * when `key` has already used `limit` requests within the current `windowMs`,
 * and `true` (recording the request) otherwise.
 *
 * Convex mutations are transactions, so concurrent bumps of the same key row
 * OCC-conflict and retry rather than over-counting — each key's count is exact.
 * A Convex mutation sees no client IP, so keys are derived from the payload
 * (email, page slug). A single global key can additionally cap total volume
 * across everyone; because every request then contends on one row, that global
 * key trades throughput for the cap and is best kept to low-traffic surfaces —
 * escalate to the sharded `@convex-dev/rate-limiter` component if it turns hot.
 */
export async function consumeRateLimit(
  ctx: MutationCtx,
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const now = Date.now();
  const row = await ctx.db
    .query("bookingRateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

  if (!row) {
    await ctx.db.insert("bookingRateLimits", {
      key,
      windowStartMs: now,
      count: 1,
    });
    return true;
  }
  if (now - row.windowStartMs >= windowMs) {
    await ctx.db.patch(row._id, { windowStartMs: now, count: 1 });
    return true;
  }
  if (row.count >= limit) {
    return false;
  }
  await ctx.db.patch(row._id, { count: row.count + 1 });
  return true;
}
