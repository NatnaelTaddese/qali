/** Write handlers for the calendar domain that stay on our side (no Google):
 * the visibility toggle and the optimistic-mirror internal mutations. Plain
 * functions; the root `calendar.ts` wraps each in a Convex mutation. */

import type { Infer } from "convex/values";

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import { ensureGoogleConnection } from "./connections";
import { googleEventValidator } from "./validators";

/** Toggle whether a calendar's events appear on the grid. */
export async function setCalendarSelectedHandler(
  ctx: MutationCtx,
  args: { calendarId: Id<"calendars">; selected: boolean },
): Promise<null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }
  const cal = await ctx.db.get(args.calendarId);
  if (!cal || cal.userId !== user._id) {
    throw new Error("Calendar not found");
  }
  await ctx.db.patch(args.calendarId, { selected: args.selected });
  return null;
}

/** Drop the local row as soon as Google accepts the delete, so the card leaves
 * the grid now rather than whenever the next sync happens to run. */
export async function deleteEventRowHandler(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    userId: string;
    calendarId?: string;
    recurringEventId?: string;
  },
): Promise<null> {
  const row = await ctx.db.get(args.eventId);
  if (row && row.userId === args.userId) {
    await ctx.db.delete(args.eventId);
  }
  if (args.recurringEventId) {
    const series = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q
          .eq("userId", args.userId)
          .eq("calendarId", args.calendarId ?? row?.calendarId ?? "")
          .eq("googleEventId", args.recurringEventId!),
      )
      .unique();
    if (series) await ctx.db.delete(series._id);
  }
  return null;
}

/** Mirror a single event into the synced table (optimistic update after create). */
export async function upsertEventHandler(
  ctx: MutationCtx,
  args: { userId: string; event: Infer<typeof googleEventValidator> },
): Promise<null> {
  // Dual-write: stamp the neutral mirror alongside the Google-named columns so
  // the row stays cutover-ready. Legacy columns remain the source of truth.
  const connectionId = await ensureGoogleConnection(ctx, args.userId);
  const doc = {
    userId: args.userId,
    ...args.event,
    connectionId,
    providerEventId: args.event.googleEventId,
    providerUpdatedMs: args.event.googleUpdatedMs,
  };
  const existing = await ctx.db
    .query("events")
    .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
      q
        .eq("userId", args.userId)
        .eq("calendarId", args.event.calendarId)
        .eq("googleEventId", args.event.googleEventId),
    )
    .unique();
  if (existing) {
    await ctx.db.replace(existing._id, doc);
  } else {
    await ctx.db.insert("events", doc);
  }
  return null;
}

/** Cache one recurring master's rule for all of its expanded instances. */
export async function upsertRecurringSeriesHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    calendarId: string;
    googleEventId: string;
    recurrence: string[];
    sourceUpdatedMs: number;
    replacedEventId?: Id<"events">;
  },
): Promise<null> {
  const existing = await ctx.db
    .query("recurringSeries")
    .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
      q
        .eq("userId", args.userId)
        .eq("calendarId", args.calendarId)
        .eq("googleEventId", args.googleEventId),
    )
    .unique();
  // Dual-write the neutral mirror (connectionId + providerEventId) on both the
  // patch and insert paths, so incremental cache refreshes keep it current too.
  const connectionId = await ensureGoogleConnection(ctx, args.userId);
  const value = {
    recurrence: args.recurrence,
    sourceUpdatedMs: args.sourceUpdatedMs,
    connectionId,
    providerEventId: args.googleEventId,
  };
  if (existing) {
    await ctx.db.patch(existing._id, value);
  } else {
    await ctx.db.insert("recurringSeries", {
      userId: args.userId,
      calendarId: args.calendarId,
      googleEventId: args.googleEventId,
      ...value,
    });
  }
  if (args.replacedEventId) {
    const replaced = await ctx.db.get(args.replacedEventId);
    if (
      replaced?.userId === args.userId &&
      replaced.calendarId === args.calendarId &&
      replaced.googleEventId === args.googleEventId
    ) {
      await ctx.db.delete(args.replacedEventId);
    }
  }
  return null;
}
