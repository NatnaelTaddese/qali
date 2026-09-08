/** Read side of the reminders domain, at `api.domains.reminders.queries.*`. */

import { v } from "convex/values";

import { query, type QueryCtx } from "../../_generated/server";
import { authComponent } from "../../auth";

const MS_PER_MINUTE = 60_000;
/** The client asks for a day; nothing needs more than this. */
const MAX_HORIZON_MS = 36 * 60 * MS_PER_MINUTE;
/** Rows a little behind `fromMs` are still returned so a client that was
 * asleep can fire what it just missed. */
const LOOKBACK_MS = 15 * MS_PER_MINUTE;
const MAX_UPCOMING = 200;

export const upcomingReminderValidator = v.object({
  deliveryId: v.id("reminderDeliveries"),
  eventId: v.id("events"),
  summary: v.optional(v.string()),
  startMs: v.number(),
  allDay: v.boolean(),
  fireAtMs: v.number(),
  minutes: v.number(),
});

/**
 * The caller's pending reminders due between `fromMs` and `fromMs + horizonMs`.
 * Convex queries re-run on writes, not on the clock, so the client passes a
 * `fromMs` it rounds to a few minutes; each bucket is a fresh subscription and
 * the previous one is dropped. Rows already fired by either channel are
 * `sent`, so they fall out of this result the moment they fire — which is how
 * the client learns to cancel its own timer.
 */
export async function upcomingHandler(
  ctx: QueryCtx,
  args: { fromMs: number; horizonMs: number },
) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return [];
  const horizon = Math.min(Math.max(args.horizonMs, 0), MAX_HORIZON_MS);
  const rows = await ctx.db
    .query("reminderDeliveries")
    .withIndex("by_user_and_status_and_fireAt", (q) =>
      q
        .eq("userId", user._id)
        .eq("status", "pending")
        .gte("fireAtMs", args.fromMs - LOOKBACK_MS)
        .lte("fireAtMs", args.fromMs + horizon),
    )
    .take(MAX_UPCOMING);
  const out = [];
  for (const row of rows) {
    const event = await ctx.db.get(row.eventId);
    if (!event || event.userId !== user._id || event.status === "cancelled") {
      continue;
    }
    out.push({
      deliveryId: row._id,
      eventId: row.eventId,
      summary: event.summary,
      startMs: event.startMs,
      allDay: event.allDay,
      fireAtMs: row.fireAtMs,
      minutes: row.minutes,
    });
  }
  return out;
}

export const upcoming = query({
  args: { fromMs: v.number(), horizonMs: v.number() },
  returns: v.array(upcomingReminderValidator),
  handler: (ctx, args) => upcomingHandler(ctx, args),
});
