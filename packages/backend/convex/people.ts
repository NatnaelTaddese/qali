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
    // Rank by engagement so callers (the guest picker) surface frequent, recent
    // meeting partners first. Ordering by the stored score reads no wall clock,
    // so it is safe in a query; the score itself is materialized during sync.
    return rows
      .map((p) => ({
        email: p.email,
        displayName: p.displayName,
        photoUrl: p.photoUrl,
        score: p.score ?? 0,
        meetingCount: p.meetingCount ?? 0,
        lastMetMs: p.lastMetMs,
        nextMeetingMs: p.nextMeetingMs,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        // Tiebreak: sooner upcoming meeting, then more recently met, then name.
        const aNext = a.nextMeetingMs ?? Infinity;
        const bNext = b.nextMeetingMs ?? Infinity;
        if (aNext !== bNext) {
          return aNext - bNext;
        }
        const aLast = a.lastMetMs ?? 0;
        const bLast = b.lastMetMs ?? 0;
        if (aLast !== bLast) {
          return bLast - aLast;
        }
        return (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email);
      });
  },
});
