import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Cross-domain infrastructure tables, composed into schema.ts. */
export const infrastructureTables = {
  // Fixed-window counters guarding the one mutation anonymous callers can
  // reach. Keyed by requester email and by page slug — a Convex mutation has no
  // client IP to key on.
  bookingRateLimits: defineTable({
    key: v.string(),
    windowStartMs: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),
};
