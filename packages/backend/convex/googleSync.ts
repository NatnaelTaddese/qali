/**
 * Compatibility-only routes for old clients and already queued calls.
 * New code schedules and cross-calls `internal.calendarSync.*` exclusively.
 */
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import * as definitions from "./domains/sync/engine";

export const syncNow = action(definitions.syncNow);
export const syncUser = internalAction(definitions.syncUser);
export const forceFullResync = internalAction(definitions.forceFullResync);
export const recomputeEngagement = internalAction(definitions.recomputeEngagement);
export const enqueueSyncs = internalMutation(definitions.enqueueSyncs);
export const enqueueEngagementRefresh = internalMutation(
  definitions.enqueueEngagementRefresh,
);
export const backfillPeople = internalMutation(definitions.backfillPeople);
export const clearCalendarEventsBatch = internalMutation(
  definitions.clearCalendarEventsBatch,
);
export const clearSharedCalendarEventsBatch = internalMutation(
  definitions.clearSharedCalendarEventsBatch,
);
export const cleanupRemovedCalendarEvents = internalMutation(
  definitions.cleanupLegacyRemovedCalendarEvents,
);
export const getSyncState = internalQuery(definitions.getSyncState);
