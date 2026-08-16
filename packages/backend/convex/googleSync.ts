/**
 * Queue-drain compatibility for pre-cutover `internal.googleSync.*` targets.
 * New code must schedule and cross-call `internal.calendarSync.*` exclusively.
 */
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import * as definitions from "./domains/sync/engine";

// Already-queued action and mutation targets from the pre-cutover sync engine.
export const syncUser = internalAction(definitions.syncUser);
export const recomputeEngagement = internalAction(definitions.recomputeEngagement);
export const enqueueSyncs = internalMutation(definitions.enqueueSyncs);
export const enqueueEngagementRefresh = internalMutation(
  definitions.enqueueEngagementRefresh,
);
export const backfillPeople = internalMutation(definitions.backfillPeople);
export const cleanupRemovedCalendarEvents = internalMutation(
  definitions.cleanupLegacyRemovedCalendarEvents,
);

// Short-lived cross-call targets for pre-cutover actions that were in flight.
export const clearCalendarEventsBatch = internalMutation(
  definitions.clearCalendarEventsBatch,
);
export const clearSharedCalendarEventsBatch = internalMutation(
  definitions.clearSharedCalendarEventsBatch,
);
export const getSyncState = internalQuery(definitions.getSyncState);
