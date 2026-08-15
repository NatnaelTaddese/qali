import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Table definitions owned by the marketing domain (the public waitlist).
 * Composed into schema.ts. */
export const marketingTables = {
  waitlist: defineTable({
    // Stored trimmed and lowercased so the dedupe check can't be fooled by case
    // or surrounding whitespace.
    email: v.string(),
    // Where the signup came from, e.g. "www". Optional so future entry points
    // don't force a schema change.
    source: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_email", ["email"]),
};
