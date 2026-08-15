/**
 * The public marketing-site waitlist. Stable facade — keeps `api.waitlist.join`
 * fixed while the logic lives in `domains/marketing/`.
 */

import { v } from "convex/values";

import { mutation } from "./_generated/server";
import { joinHandler } from "./domains/marketing/mutations";

export const join = mutation({
  args: {
    email: v.string(),
    /** Where the signup came from, e.g. "www". */
    source: v.optional(v.string()),
  },
  returns: v.null(),
  handler: (ctx, args) => joinHandler(ctx, args),
});
