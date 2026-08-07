import { query } from "./_generated/server";
import { authComponent } from "./auth";

// How many people the picker/assistant load. Ordered by engagement, so this is
// the top-N most relevant; a personal directory rarely exceeds it. Bounds the
// bytes each connected client reads per subscription.
const PEOPLE_LIMIT = 500;

/** The unified people directory for the current user: the email-keyed union of
 * saved Google connections, Other Contacts, and people harvested from calendar
 * events. This is what the client joins attendee emails against for names and
 * avatars, so a guest the user has met but never saved still resolves to a real
 * photo when Google has one.
 *
 * Read via the `by_user_and_score` index in descending order, so the most-met
 * people come first straight from the index — no whole-directory load or
 * JS sort per client. The score is materialized during sync (the recency decay
 * needs the wall clock, which a query may not read). People with no shared
 * meetings have no score and sort to the tail, still available for search. */
export const listPeople = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return [];
    }
    const rows = await ctx.db
      .query("people")
      .withIndex("by_user_and_score", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(PEOPLE_LIMIT);
    return rows.map((p) => ({
      email: p.email,
      displayName: p.displayName,
      photoUrl: p.photoUrl,
      score: p.score ?? 0,
      meetingCount: p.meetingCount ?? 0,
      lastMetMs: p.lastMetMs,
      nextMeetingMs: p.nextMeetingMs,
    }));
  },
});
