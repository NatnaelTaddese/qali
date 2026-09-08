/** Write side of the reminders domain, at `api.domains.reminders.mutations.*`. */

import { v } from "convex/values";

import type { Id } from "../../_generated/dataModel";
import { mutation, type MutationCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import { insertReminderNotification, reminderPayload } from "./model";

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
