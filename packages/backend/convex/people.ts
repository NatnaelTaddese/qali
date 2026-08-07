import { query } from "./_generated/server";
import { authComponent } from "./auth";

/** The unified people directory for the current user: the email-keyed union of
 * saved Google connections, Other Contacts, and people harvested from calendar
 * events. This is what the client joins attendee emails against for names and
 * avatars, so a guest the user has met but never saved still resolves to a real
 * photo when Google has one. Returns just the join fields. */
export const listPeople = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    const rows = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(1000);
    return rows.map((p) => ({
      email: p.email,
      displayName: p.displayName,
      photoUrl: p.photoUrl,
    }));
  },
});
