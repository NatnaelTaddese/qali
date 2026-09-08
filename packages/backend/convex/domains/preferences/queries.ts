/** Read side of the preferences domain. Registration is canonical here, under
 * `api.domains.preferences.queries.*`. */

import { v } from "convex/values";

import type { Doc } from "../../_generated/dataModel";
import {
  internalQuery,
  query,
  type QueryCtx,
} from "../../_generated/server";
import { authComponent } from "../../auth";
import { preferenceFields } from "./tables";

/** The current user's stored preferences. A deliberate DTO: absent fields mean
 * "automatic" and the client resolves them (browser zone, app defaults).
 * Returns `null` when unauthenticated, matching listCalendars' empty result. */
export async function getMyPreferencesHandler(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    return null;
  }
  const prefs = await ctx.db
    .query("userPreferences")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .unique();
  return preferencesDto(prefs);
}

/** The DTO shape: exactly the preference fields, nothing about the row. */
export function preferencesDto(prefs: Doc<"userPreferences"> | null) {
  return {
    timeZone: prefs?.timeZone,
    weekStartsOn: prefs?.weekStartsOn,
    timeFormat: prefs?.timeFormat,
    defaultView: prefs?.defaultView,
    defaultCalendarId: prefs?.defaultCalendarId,
    defaultReminderMinutes: prefs?.defaultReminderMinutes,
    defaultAllDayReminderMinutes: prefs?.defaultAllDayReminderMinutes,
  };
}

export const getMyPreferences = query({
  args: {},
  returns: v.union(v.null(), v.object(preferenceFields)),
  handler: (ctx) => getMyPreferencesHandler(ctx),
});

/** A user's stored preferences row for server-side callers (actions resolving
 * reminder defaults). `null` when the user never set anything. */
export const getPreferencesForUser = internalQuery({
  args: { userId: v.string() },
  returns: v.union(v.null(), v.object(preferenceFields)),
  handler: async (ctx, args) => {
    const prefs = await ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    return prefs ? preferencesDto(prefs) : null;
  },
});
