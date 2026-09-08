/** Write side of the reminders domain, at `api.domains.reminders.mutations.*`. */

import { v } from "convex/values";

import type { Id } from "../../_generated/dataModel";
import { mutation, type MutationCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  insertReminderNotification,
  reminderPayload,
  reminderRowIsStale,
} from "./model";

/** How far ahead of a row's fire time a tab may claim it. */
const CLIENT_CLOCK_SKEW_MS = 60_000;

/**
 * A tab that fired a reminder itself records it here *before* showing it.
 * Only a still-pending row owned by the caller flips; `fired: false` means
 * the sweep already took it (its push is on the way), so the tab shows
 * nothing and no one is told twice. Exported so itests can drive it with an
 * explicit userId.
 */
export async function markFiredCore(
  ctx: MutationCtx,
  userId: string,
  args: { eventId: Id<"events">; minutes: number },
): Promise<{ fired: boolean }> {
  const row = await ctx.db
    .query("reminderDeliveries")
    .withIndex("by_event_and_minutes", (q) =>
      q.eq("eventId", args.eventId).eq("minutes", args.minutes),
    )
    .unique();
  if (!row || row.userId !== userId || row.status !== "pending") {
    return { fired: false };
  }
  const event = await ctx.db.get(args.eventId);
  if (!event || event.userId !== userId) return { fired: false };
  const now = Date.now();
  // A tab's timer may be early (the row was re-timed under it) or the row
  // may have gone stale (calendar hidden, event moved); apply the sweep's
  // rules so neither channel delivers what the other would refuse.
  if (row.fireAtMs > now + CLIENT_CLOCK_SKEW_MS) return { fired: false };
  const calendar = await ctx.db.get(event.localCalendarId);
  const prefs = await ctx.db
    .query("userPreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (reminderRowIsStale({ row, event, calendar, prefs, nowMs: now })) {
    return { fired: false };
  }
  await ctx.db.patch(row._id, {
    status: "sent",
    channel: "client",
    sentAt: now,
  });
  await insertReminderNotification(
    ctx,
    userId,
    reminderPayload(event, args.minutes),
    now,
  );
  return { fired: true };
}

export const markFired = mutation({
  args: { eventId: v.id("events"), minutes: v.number() },
  returns: v.object({ fired: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return { fired: false };
    return markFiredCore(ctx, user._id, args);
  },
});
