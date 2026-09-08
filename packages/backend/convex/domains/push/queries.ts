/** Read side of the push domain, at `api.domains.push.queries.*`. */

import { v } from "convex/values";

import { internalQuery, query } from "../../_generated/server";

/** The deployment's VAPID public key, or `null` when push is not configured
 * — the client hides its notifications toggle then. Served from the same
 * deployment as the private key so the pair can never drift between builds.
 * Public by design; no auth. */
export const vapidPublicKey = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async () => process.env.VAPID_PUBLIC_KEY || null,
});

export const listSubscriptionsForUser = internalQuery({
  args: { userId: v.string() },
  returns: v.array(
    v.object({
      endpoint: v.string(),
      keys: v.object({ p256dh: v.string(), auth: v.string() }),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    return rows.map((row) => ({ endpoint: row.endpoint, keys: row.keys }));
  },
});
