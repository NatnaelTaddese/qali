/**
 * The public marketing-site waitlist: anyone can leave an email to be notified
 * at launch. This is an anonymous surface, so `join` normalizes the address and
 * dedupes against the `by_email` index — a repeat signup (or a network retry of
 * the same request) is a no-op, never a second row.
 */

import { v } from "convex/values";

import { mutation } from "./_generated/server";

/** Add an email to the waitlist. Idempotent by email: an address already on the
 * list is treated as success without inserting again, so double-submits and
 * retries stay harmless. */
export const join = mutation({
  args: {
    email: v.string(),
    /** Where the signup came from, e.g. "www". */
    source: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const email = args.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
      throw new Error("Please enter a valid email address");
    }

    const existing = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existing) {
      return null;
    }

    await ctx.db.insert("waitlist", {
      email,
      source: args.source,
      createdAt: Date.now(),
    });
    return null;
  },
});
