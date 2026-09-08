/**
 * The reminder ledger's plain helpers: no function wrappers, just what every
 * event write path and the materialiser call to keep `reminderDeliveries`
 * in line with `events`. Provider-neutral by construction — it only ever
 * reads the stored event, its calendar, and the user's preferences.
 */

import {
  MATERIALIZE_LOOKAHEAD_MS,
  MATERIALIZE_LOOKBACK_MS,
  plannedReminders,
  resolvePopupMinutes,
} from "@qali/domain/reminders";
import type { Infer } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { pushPayloadValidator } from "./validators";

export type PushPayload = Infer<typeof pushPayloadValidator>;

export interface ReminderContext {
  readonly prefs: Doc<"userPreferences"> | null;
  readonly calendarsById: Map<Id<"calendars">, Doc<"calendars">>;
}

/** One prefs read plus the user's calendars: everything the reconcile needs
 * for any number of that user's events. */
export async function loadReminderContext(
  ctx: QueryCtx,
  userId: string,
): Promise<ReminderContext> {
  const prefs = await ctx.db
    .query("userPreferences")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return {
    prefs,
    calendarsById: new Map(calendars.map((row) => [row._id, row])),
  };
}

/** Whether an event's start falls in the window the ledger materialises. */
export function inReminderWindow(startMs: number, nowMs: number): boolean {
  return (
    startMs >= nowMs - MATERIALIZE_LOOKBACK_MS &&
    startMs <= nowMs + MATERIALIZE_LOOKAHEAD_MS
  );
}

/** The zone an all-day reminder is anchored in: the calendar's, else the
 * user's working zone, else UTC. */
export function reminderTimeZone(
  calendar: Pick<Doc<"calendars">, "timeZone"> | undefined,
  prefs: Pick<Doc<"userPreferences">, "timeZone"> | null,
): string {
  return calendar?.timeZone ?? prefs?.timeZone ?? "UTC";
}

/**
 * Bring the ledger rows for one event in line with what should fire.
 * Idempotent and cheap (one prefix read, a handful of writes), so it is safe
 * to call on every sync page. Rules:
 *  - An event outside the window, cancelled, or on a deselected/shared
 *    calendar keeps no pending rows. The window check happens before the
 *    read so far-off rows cost nothing; a row that drifts out of the window
 *    is caught by the sweep's staleness check instead.
 *  - A `sent` row never fires again for that (event, offset), even if the
 *    event moves afterwards — matches what Google does and avoids
 *    re-notifying an edit.
 *  - Anything else is (re)planned: fireAt patched when the event moved,
 *    offsets no longer wanted deleted, new ones inserted.
 */
export async function reconcileEventReminders(
  ctx: MutationCtx,
  event: Doc<"events">,
  rc: ReminderContext,
  nowMs = Date.now(),
): Promise<void> {
  const calendar = rc.calendarsById.get(event.localCalendarId);
  const eligible =
    calendar !== undefined &&
    calendar.selected &&
    !calendar.isShared &&
    event.status !== "cancelled";
  if (!eligible || !inReminderWindow(event.startMs, nowMs)) {
    if (eligible) return;
    await clearPendingRemindersForEvent(ctx, event._id);
    return;
  }

  const timeZone = reminderTimeZone(calendar, rc.prefs);
  const minutes = resolvePopupMinutes({
    eventReminders: event.reminders,
    allDay: event.allDay,
    calendarDefaults: calendar.defaultReminders,
    preferredMinutes: rc.prefs?.defaultReminderMinutes,
    preferredAllDayMinutes: rc.prefs?.defaultAllDayReminderMinutes,
  });
  const planned = new Map(
    plannedReminders({
      startMs: event.startMs,
      allDay: event.allDay,
      timeZone,
      minutes,
      nowMs,
    }).map((row) => [row.minutes, row]),
  );

  const existing = await ctx.db
    .query("reminderDeliveries")
    .withIndex("by_event_and_minutes", (q) => q.eq("eventId", event._id))
    .collect();
  for (const row of existing) {
    const want = planned.get(row.minutes);
    if (!want) {
      if (row.status === "pending") await ctx.db.delete(row._id);
      continue;
    }
    planned.delete(row.minutes);
    if (row.status === "sent") continue;
    if (
      row.status !== "pending" ||
      row.fireAtMs !== want.fireAtMs ||
      row.eventStartMs !== event.startMs
    ) {
      await ctx.db.patch(row._id, {
        status: "pending",
        fireAtMs: want.fireAtMs,
        eventStartMs: event.startMs,
      });
    }
  }
  for (const want of planned.values()) {
    await ctx.db.insert("reminderDeliveries", {
      userId: event.userId,
      eventId: event._id,
      minutes: want.minutes,
      fireAtMs: want.fireAtMs,
      eventStartMs: event.startMs,
      status: "pending",
      createdAt: nowMs,
    });
  }
}

/** Drop the rows that have not fired for an event that is going away (or
 * leaving the eligible set). Settled rows stay as history until the prune. */
export async function clearPendingRemindersForEvent(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<void> {
  const rows = await ctx.db
    .query("reminderDeliveries")
    .withIndex("by_event_and_minutes", (q) => q.eq("eventId", eventId))
    .collect();
  for (const row of rows) {
    if (row.status === "pending") await ctx.db.delete(row._id);
  }
}

/** Every ledger row for an event, settled or not — for a hard delete. */
export async function deleteRemindersForEvent(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<void> {
  const rows = await ctx.db
    .query("reminderDeliveries")
    .withIndex("by_event_and_minutes", (q) => q.eq("eventId", eventId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** "Starts in 10 min" / "Tomorrow, all day": phrased off the offset so it
 * reads right in any zone, and stays true while the notification sits in
 * the tray. */
export function reminderBody(allDay: boolean, minutes: number): string {
  if (allDay) {
    const days = Math.ceil(minutes / MINUTES_PER_DAY);
    if (days <= 0) return "Today, all day";
    if (days === 1) return "Tomorrow, all day";
    return `In ${days} days, all day`;
  }
  if (minutes <= 0) return "Starts now";
  if (minutes < MINUTES_PER_HOUR) return `Starts in ${minutes} min`;
  if (minutes < MINUTES_PER_DAY) {
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    const rest = minutes % MINUTES_PER_HOUR;
    const h = `${hours} ${hours === 1 ? "hour" : "hours"}`;
    return rest === 0 ? `Starts in ${h}` : `Starts in ${h} ${rest} min`;
  }
  const days = Math.round(minutes / MINUTES_PER_DAY);
  if (days === 1) return "Tomorrow";
  if (days === 7) return "In a week";
  return `In ${days} days`;
}

export function reminderTitle(event: Pick<Doc<"events">, "summary">): string {
  return event.summary?.trim() || "(No title)";
}

export function reminderTag(eventId: Id<"events">, minutes: number): string {
  return `reminder:${eventId}:${minutes}`;
}

export function reminderPayload(
  event: Pick<Doc<"events">, "_id" | "summary" | "startMs" | "allDay">,
  minutes: number,
): PushPayload {
  return {
    kind: "event_reminder",
    eventId: event._id,
    title: reminderTitle(event),
    body: reminderBody(event.allDay, minutes),
    startMs: event.startMs,
    allDay: event.allDay,
    minutes,
    url: `/?event=${event._id}`,
    tag: reminderTag(event._id, minutes),
  };
}

/** The in-app notification row for a fired reminder. */
export async function insertReminderNotification(
  ctx: MutationCtx,
  userId: string,
  payload: PushPayload,
  nowMs: number,
): Promise<void> {
  await ctx.db.insert("notifications", {
    userId,
    type: "event_reminder",
    title: payload.title,
    body: payload.body,
    eventId: payload.eventId,
    read: false,
    createdAt: nowMs,
  });
}
