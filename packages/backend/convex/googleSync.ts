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
import * as compat from "./domains/sync/googleCompat";

// Already-queued action and mutation targets from the pre-cutover sync engine.
export const syncUser = internalAction(definitions.syncUser);
export const recomputeEngagement = internalAction(definitions.recomputeEngagement);
export const enqueueSyncs = internalMutation(compat.enqueueSyncs);
export const enqueueEngagementRefresh = internalMutation(
  compat.enqueueEngagementRefresh,
);
export const backfillPeople = internalMutation(definitions.backfillPeople);
export const cleanupRemovedCalendarEvents = internalMutation(
  definitions.cleanupLegacyRemovedCalendarEvents,
);

// Short-lived cross-call targets for pre-cutover actions that were in flight.
export const getSyncState = internalQuery(compat.getSyncState);
export const ensureSyncState = internalMutation(compat.ensureSyncState);
export const claimSyncLease = internalMutation(compat.claimSyncLease);
export const recordSyncOutcome = internalMutation(compat.recordSyncOutcome);
export const listCalendarsForUser = internalQuery(compat.listCalendarsForUser);
export const reconcileCalendars = internalMutation(compat.reconcileCalendars);
export const clearCalendarEventsBatch = internalMutation(
  compat.clearCalendarEventsBatch,
);
export const beginCalendarFullResync = internalMutation(
  compat.beginCalendarFullResync,
);
export const upsertEventsPage = internalMutation(compat.upsertEventsPage);
export const sweepStaleCalendarEventsBatch = internalMutation(
  compat.sweepStaleCalendarEventsBatch,
);
export const commitCalendarFullResync = internalMutation(
  compat.commitCalendarFullResync,
);
export const setCalendarSyncToken = internalMutation(compat.setCalendarSyncToken);
export const claimSharedCalendarSync = internalMutation(
  compat.claimSharedCalendarSync,
);
export const releaseSharedCalendarLease = internalMutation(
  compat.releaseSharedCalendarLease,
);
export const clearSharedCalendarEventsBatch = internalMutation(
  compat.clearSharedCalendarEventsBatch,
);
export const upsertSharedEventsPage = internalMutation(
  compat.upsertSharedEventsPage,
);
export const setSharedCalendarSynced = internalMutation(
  compat.setSharedCalendarSynced,
);
export const beginContactsFullResync = internalMutation(
  compat.beginContactsFullResync,
);
export const upsertContactsPage = internalMutation(compat.upsertContactsPage);
export const upsertOtherContactsPage = internalMutation(
  compat.upsertOtherContactsPage,
);
export const sweepStaleContactsBatch = internalMutation(
  compat.sweepStaleContactsBatch,
);
export const sweepStaleOtherPeopleBatch = internalMutation(
  compat.sweepStaleOtherPeopleBatch,
);
export const setContactsSync = internalMutation(compat.setContactsSync);
export const setOtherContactsSync = internalMutation(compat.setOtherContactsSync);
export const listEventsPageForEngagement = internalQuery(
  compat.listEventsPageForEngagement,
);
export const applyEngagementScores = internalMutation(
  compat.applyEngagementScores,
);
