/** Write side of the push domain, at `api.domains.push.mutations.*`. */

import { v } from "convex/values";

import { internalMutation, mutation, type MutationCtx } from "../../_generated/server";
import { authComponent } from "../../auth";

/** A browser keeps one subscription per origin, but a user may have many
 * browsers. Beyond this the oldest is dropped rather than the table growing. */
const MAX_SUBSCRIPTIONS_PER_USER = 10;

const subscriptionArgs = {
  endpoint: v.string(),
  keys: v.object({ p256dh: v.string(), auth: v.string() }),
  expirationTime: v.optional(v.number()),
  userAgent: v.optional(v.string()),
};

/** Upsert by endpoint (the Push API's own unique key). A subscription that
 * re-registers under another login is rebound, not duplicated. Exported so
 * itests can drive it with an explicit userId. */
export async function subscribeCore(
  ctx: MutationCtx,
  userId: string,
  args: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    expirationTime?: number;
    userAgent?: string;
  },
): Promise<null> {
  let endpoint: URL;
  try {
    endpoint = new URL(args.endpoint);
  } catch {
    throw new Error("Invalid push endpoint");
  }
  if (endpoint.protocol !== "https:") {
    throw new Error("Push endpoints must be https");
  }
  const now = Date.now();
  const existing = await ctx.db
    .query("pushSubscriptions")
    .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, {
      userId,
      keys: args.keys,
      expirationTime: args.expirationTime,
      userAgent: args.userAgent?.slice(0, 500),
      lastUsedAt: now,
      failedAt: undefined,
    });
    return null;
  }
  const mine = await ctx.db
    .query("pushSubscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  if (mine.length >= MAX_SUBSCRIPTIONS_PER_USER) {
    const oldest = [...mine].sort((a, b) => a.createdAt - b.createdAt);
    for (const row of oldest.slice(0, mine.length - MAX_SUBSCRIPTIONS_PER_USER + 1)) {
      await ctx.db.delete(row._id);
    }
  }
  await ctx.db.insert("pushSubscriptions", {
    userId,
    endpoint: args.endpoint,
    keys: args.keys,
    expirationTime: args.expirationTime,
    userAgent: args.userAgent?.slice(0, 500),
    createdAt: now,
    lastUsedAt: now,
  });
  return null;
}

export const subscribe = mutation({
  args: subscriptionArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) throw new Error("Not authenticated");
    return subscribeCore(ctx, user._id, args);
  },
});

export async function unsubscribeCore(
  ctx: MutationCtx,
  userId: string,
  args: { endpoint: string },
): Promise<null> {
  const row = await ctx.db
    .query("pushSubscriptions")
    .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
    .unique();
  if (row && row.userId === userId) await ctx.db.delete(row._id);
  return null;
}

export const unsubscribe = mutation({
  args: { endpoint: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return null;
    return unsubscribeCore(ctx, user._id, args);
  },
});

/** The push action reports back: gone endpoints (404/410) are deleted,
 * delivered ones stamped, failed ones marked so a later prune can decide. */
export async function recordPushResultsCore(
  ctx: MutationCtx,
  args: {
    userId: string;
    delivered: string[];
    gone: string[];
    failed: string[];
  },
): Promise<null> {
  const now = Date.now();
  const byEndpoint = async (endpoint: string) => {
    const row = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .unique();
    return row && row.userId === args.userId ? row : null;
  };
  for (const endpoint of new Set(args.gone)) {
    const row = await byEndpoint(endpoint);
    if (row) await ctx.db.delete(row._id);
  }
  for (const endpoint of new Set(args.delivered)) {
    const row = await byEndpoint(endpoint);
    if (row) await ctx.db.patch(row._id, { lastUsedAt: now, failedAt: undefined });
  }
  for (const endpoint of new Set(args.failed)) {
    const row = await byEndpoint(endpoint);
    if (row) await ctx.db.patch(row._id, { failedAt: now });
  }
  return null;
}

export const recordPushResults = internalMutation({
  args: {
    userId: v.string(),
    delivered: v.array(v.string()),
    gone: v.array(v.string()),
    failed: v.array(v.string()),
  },
  returns: v.null(),
  handler: (ctx, args) => recordPushResultsCore(ctx, args),
});
