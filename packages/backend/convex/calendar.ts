/**
 * Drain-only compatibility facade - keeps the pre-cutover `api.calendar.*` /
 * `internal.calendar.*` paths registered while persisted scheduler entries and
 * stale clients drain.
 * Canonical registration: domains/calendar/{queries,mutations,service}.ts.
 * Removal gate: MIGRATION_RUNBOOK.md section 7.
 */

import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import {
  deleteEventRowHandler,
  upsertEventHandler,
  upsertRecurringSeriesHandler,
} from "./domains/calendar/mutations";
import { getPrimaryCalendarIdHandler } from "./domains/calendar/queries";
import { googleEventValidator } from "./domains/calendar/validators";

// Re-exported for the web app, which types its calendar grid against it.
export type { EventView } from "./domains/calendar/model";

export {
  getCalendarConnectionForAdapter,
  getEventById,
  getEventContext,
  getEventRecurrence,
  listCalendars,
  listEventsInRange,
  listSharedEventsForAssistant,
} from "./domains/calendar/queries";
export {
  claimCalendarOperation,
  deleteProviderEventMirror,
  mirrorProviderEvent,
  resolveCreateTarget,
  resolveEventWriteTarget,
  setCalendarSelected,
  settleCalendarOperation,
  upsertProviderRecurringSeries,
} from "./domains/calendar/mutations";
export {
  createEvent,
  deleteEvent,
  refreshEventRecurrence,
  respondToEvent,
  updateEvent,
  updateEventTime,
} from "./domains/calendar/service";

// --- Legacy in-flight shims ----------------------------------------------
// Registered here only, with no `internal.domains.calendar.*` counterpart:
// they exist for persisted scheduler entries still addressing the legacy
// Google-shaped surface, and new code must not call them. Removal gate:
// MIGRATION_RUNBOOK.md section 7.

export const getPrimaryCalendarId = internalQuery({
  args: { userId: v.string() },
  handler: (ctx, args) => getPrimaryCalendarIdHandler(ctx, args),
});

export const deleteEventRow = internalMutation({
  args: {
    eventId: v.id("events"),
    userId: v.string(),
    calendarId: v.optional(v.string()),
    recurringEventId: v.optional(v.string()),
  },
  handler: (ctx, args) => deleteEventRowHandler(ctx, args),
});

export const upsertEvent = internalMutation({
  args: { userId: v.string(), event: googleEventValidator },
  handler: (ctx, args) => upsertEventHandler(ctx, args),
});

export const upsertRecurringSeries = internalMutation({
  args: {
    userId: v.string(),
    calendarId: v.string(),
    googleEventId: v.string(),
    recurrence: v.array(v.string()),
    sourceUpdatedMs: v.number(),
    replacedEventId: v.optional(v.id("events")),
  },
  handler: (ctx, args) => upsertRecurringSeriesHandler(ctx, args),
});
