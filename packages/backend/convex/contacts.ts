import { query } from "./_generated/server";
import { authComponent } from "./auth";

/** Contacts for the current user, read from the synced `contacts` table. */
export const listContacts = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    return await ctx.db
      .query("contacts")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(200);
  },
});
