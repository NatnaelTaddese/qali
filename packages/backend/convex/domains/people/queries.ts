/** Read side of the people domain: plain handlers plus the canonical `query`
 * registrations. The root `people.ts` facade re-exports the registered objects
 * so the legacy `api.people.*` paths stay live. */

import { v } from "convex/values";

import { internalQuery, query, type QueryCtx } from "../../_generated/server";
import { authComponent } from "../../auth";

// How many people the picker/assistant load. Ordered by engagement, so this is
// the top-N most relevant; a personal directory rarely exceeds it. Bounds the
// bytes each connected client reads per subscription.
const PEOPLE_LIMIT = 500;

/** The unified people directory for one user: the email-keyed union of saved
 * Google connections, Other Contacts, and people harvested from calendar
 * events. Read via `by_user_and_score` descending, so the most-met people come
 * first straight from the index — no whole-directory load or JS sort per client.
 * People with no shared meetings have no score and sort to the tail. */
export async function listPeopleForUserHandler(ctx: QueryCtx, userId: string) {
  const rows = await ctx.db
    .query("people")
    .withIndex("by_user_and_score", (q) => q.eq("userId", userId))
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
}

export async function listPeopleHandler(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return [];
  }
  return await listPeopleForUserHandler(ctx, user._id);
}

export const listPeople = query({
  args: {},
  handler: (ctx) => listPeopleHandler(ctx),
});

/** For callers that already hold a verified user id (the assistant loop), so a
 * lookup does not resolve the session a second time. */
export const listPeopleForUser = internalQuery({
  args: { userId: v.string() },
  handler: (ctx, args) => listPeopleForUserHandler(ctx, args.userId),
});
