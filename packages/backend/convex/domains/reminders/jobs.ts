/**
 * The reminder ledger's scheduled work, registered at
 * `internal.domains.reminders.jobs.*`:
 *  - a 6-hourly materialiser that walks each user's events inside the window
 *    and reconciles the ledger (the write-path hooks keep it fresh between
 *    runs; this catches events that merely aged into the window);
 *  - a 1-minute sweep that fires due rows: marks them sent, writes the
 *    in-app notification, and hands one push action per user its payloads.
 * Same enqueue → fan-out → self-reschedule shape as the other crons.
 */

import { v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import {
  insertReminderNotification,
  loadReminderContext,
  reconcileEventReminders,
  reminderPayload,
  reminderRowIsStale,
  type PushPayload,
} from "./model";

const USER_FANOUT_BATCH = 50;
const MATERIALIZE_BATCH = 200;
const SWEEP_BATCH = 100;
const PRUNE_BATCH = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Settled rows are kept a week for debugging, then dropped. */
const DELIVERY_RETENTION_MS = 7 * MS_PER_DAY;
/** Rows materialised before we ever started and still pending after this
 * long are stale by any reading; the sweep would skip them one by one. */
const STALE_PENDING_MS = 7 * MS_PER_DAY;

export const enqueueReminderMaterialize = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("userSyncState")
      .paginate({ cursor: args.cursor ?? null, numItems: USER_FANOUT_BATCH });
    for (const row of page.page) {
      await ctx.scheduler.runAfter(
        0,
        internal.domains.reminders.jobs.materializeUserReminders,
        { userId: row.userId },
      );
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.domains.reminders.jobs.enqueueReminderMaterialize,
        { cursor: page.continueCursor },
      );
    }
    return null;
  },
});

/** Reconcile every in-window event for one user, in bounded pages. */
export const materializeUserReminders = internalMutation({
  args: {
    userId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const rc = await loadReminderContext(ctx, args.userId);
    const page = await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) =>
        q
          .eq("userId", args.userId)
          .gte("startMs", now - MATERIALIZE_LOOKBACK_MS)
          .lte("startMs", now + MATERIALIZE_LOOKAHEAD_MS),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: MATERIALIZE_BATCH });
    for (const event of page.page) {
      await reconcileEventReminders(ctx, event, rc, now);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.domains.reminders.jobs.materializeUserReminders,
        { userId: args.userId, cursor: page.continueCursor },
      );
    }
    return null;
  },
});

// Re-exported so the query above and the model agree on one window.
import {
  MATERIALIZE_LOOKAHEAD_MS,
  MATERIALIZE_LOOKBACK_MS,
} from "@qali/domain/reminders";

/**
 * Fire everything due. The `pending → sent` patch happens in the same
 * transaction as the decision, so a concurrent client `markFired` and this
 * sweep can never both deliver the same (event, offset).
 */
export const sweepDueReminders = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const now = Date.now();
    const due = await ctx.db
      .query("reminderDeliveries")
      .withIndex("by_status_and_fireAt", (q) =>
        q.eq("status", "pending").lte("fireAtMs", now),
      )
      .take(SWEEP_BATCH);

    const calendars = new Map<Id<"calendars">, Doc<"calendars"> | null>();
    const calendarFor = async (id: Id<"calendars">) => {
      if (!calendars.has(id)) calendars.set(id, await ctx.db.get(id));
      return calendars.get(id) ?? null;
    };
    // The all-day anchor zone falls back to the user's working zone, exactly
    // as the reconcile planned it; judging in UTC would skip real rows.
    const prefs = new Map<string, Doc<"userPreferences"> | null>();
    const prefsFor = async (userId: string) => {
      if (!prefs.has(userId)) {
        prefs.set(
          userId,
          await ctx.db
            .query("userPreferences")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .unique(),
        );
      }
      return prefs.get(userId) ?? null;
    };
    const byUser = new Map<string, PushPayload[]>();

    for (const row of due) {
      const event = await ctx.db.get(row.eventId);
      const calendar = event ? await calendarFor(event.localCalendarId) : null;
      const stale = reminderRowIsStale({
        row,
        event,
        calendar,
        prefs: await prefsFor(row.userId),
        nowMs: now,
      });
      if (stale || !event) {
        await ctx.db.patch(row._id, { status: "skipped" });
        continue;
      }
      await ctx.db.patch(row._id, {
        status: "sent",
        channel: "server",
        sentAt: now,
      });
      const payload = reminderPayload(event, row.minutes);
      await insertReminderNotification(ctx, row.userId, payload, now);
      const list = byUser.get(row.userId);
      if (list) list.push(payload);
      else byUser.set(row.userId, [payload]);
    }

    for (const [userId, notifications] of byUser) {
      const subscribed = await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();
      if (!subscribed) continue;
      await ctx.scheduler.runAfter(
        0,
        internal.integrations.push.send.sendToUser,
        { userId, notifications },
      );
    }

    if (due.length === SWEEP_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.domains.reminders.jobs.sweepDueReminders,
        {},
      );
    }
    return null;
  },
});

/** Drop settled rows older than the retention, and pending rows nobody
 * will ever fire (their fire instant is a week gone). */
export const pruneReminderDeliveries = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const now = Date.now();
    const cutoff = now - Math.max(DELIVERY_RETENTION_MS, STALE_PENDING_MS);
    const rows = await ctx.db
      .query("reminderDeliveries")
      .withIndex("by_fireAt", (q) => q.lt("fireAtMs", cutoff))
      .take(PRUNE_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.domains.reminders.jobs.pruneReminderDeliveries,
        {},
      );
    }
    return null;
  },
});
