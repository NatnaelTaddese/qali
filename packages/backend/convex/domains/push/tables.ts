import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Table definitions owned by the push domain, composed into schema.ts. */
export const pushTables = {
  // One row per browser Web Push subscription. `endpoint` is globally unique
  // per the Push API, so it is the upsert key: a subscription re-registered
  // under a different login is rebound to that user rather than duplicated.
  pushSubscriptions: defineTable({
    userId: v.string(),
    endpoint: v.string(),
    keys: v.object({ p256dh: v.string(), auth: v.string() }),
    expirationTime: v.optional(v.number()),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    // Last non-fatal push failure (429/5xx). A 404/410 deletes the row instead.
    failedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_endpoint", ["endpoint"]),
};
