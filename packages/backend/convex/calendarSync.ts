/** Canonical registration surface for provider-neutral calendar synchronization. */
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import * as definitions from "./domains/sync/engine";
import * as compat from "./domains/sync/googleCompat";

export {
  CALENDAR_FUTURE_MS,
  CALENDAR_HISTORY_MS,
  refreshConnectionCalendar,
  syncNowForCurrentUser,
} from "./domains/sync/engine";

export const syncNow = action(definitions.syncNow);
export const syncUser = internalAction(definitions.syncUser);
export const syncConnection = internalAction(definitions.syncConnection);
export const forceFullResync = internalAction(definitions.forceFullResync);
export const recomputeEngagement = internalAction(definitions.recomputeEngagement);

export const listActiveConnections = internalQuery(
  definitions.listActiveConnections,
);
export const getConnectionSyncState = internalQuery(
  definitions.getConnectionSyncState,
);
export const listCalendarsForUser = internalQuery(
  definitions.listCalendarsForUser,
);
export const listEventsPageForEngagement = internalQuery(
  definitions.listEventsPageForEngagement,
);

export const ensureSyncState = internalMutation(definitions.ensureSyncState);
export const claimSyncLease = internalMutation(definitions.claimSyncLease);
export const heartbeatSyncLease = internalMutation(
  definitions.heartbeatSyncLease,
);
export const recordSyncOutcome = internalMutation(
  definitions.recordSyncOutcome,
);
export const enqueueSyncs = internalMutation(definitions.enqueueSyncs);
export const enqueueEngagementRefresh = internalMutation(
  definitions.enqueueEngagementRefresh,
);
export const markEngagementDirty = internalMutation(
  definitions.markEngagementDirty,
);
export const claimEngagement = internalMutation(definitions.claimEngagement);
export const heartbeatEngagement = internalMutation(
  definitions.heartbeatEngagement,
);
export const applyEngagementScoreChunk = internalMutation(
  definitions.applyEngagementScoreChunk,
);
export const resetStaleEngagementScores = internalMutation(
  definitions.resetStaleEngagementScores,
);
export const finishEngagement = internalMutation(definitions.finishEngagement);
export const reconcileCalendars = internalMutation(
  definitions.reconcileCalendars,
);
export const cleanupRemovedCalendarEvents = internalMutation(
  definitions.cleanupRemovedCalendarEvents,
);
export const cleanupLegacyRemovedCalendarEvents = internalMutation(
  definitions.cleanupLegacyRemovedCalendarEvents,
);
export const beginCalendarFullResync = internalMutation(
  definitions.beginCalendarFullResync,
);
export const upsertEventsPage = internalMutation(definitions.upsertEventsPage);
export const sweepStaleCalendarEventsBatch = internalMutation(
  definitions.sweepStaleCalendarEventsBatch,
);
export const commitCalendarFullResync = internalMutation(
  definitions.commitCalendarFullResync,
);
export const setCalendarSyncCursor = internalMutation(
  definitions.setCalendarSyncCursor,
);
export const claimSharedCalendarSync = internalMutation(
  definitions.claimSharedCalendarSync,
);
export const beginSharedFullResync = internalMutation(
  definitions.beginSharedFullResync,
);
export const heartbeatSharedCalendarLease = internalMutation(
  definitions.heartbeatSharedCalendarLease,
);
export const releaseSharedCalendarLease = internalMutation(
  definitions.releaseSharedCalendarLease,
);
export const upsertSharedEventsPage = internalMutation(
  definitions.upsertSharedEventsPage,
);
export const sweepStaleSharedEventsBatch = internalMutation(
  definitions.sweepStaleSharedEventsBatch,
);
export const commitSharedCalendarSync = internalMutation(
  definitions.commitSharedCalendarSync,
);
export const beginContactsFullResync = internalMutation(
  definitions.beginContactsFullResync,
);
export const upsertContactsPage = internalMutation(
  definitions.upsertContactsPage,
);
export const sweepStaleContactsBatch = internalMutation(
  definitions.sweepStaleContactsBatch,
);
export const sweepLegacyOtherPeopleBatch = internalMutation(
  definitions.sweepLegacyOtherPeopleBatch,
);
export const commitContactsSync = internalMutation(
  definitions.commitContactsSync,
);
export const applyEngagementScores = internalMutation(
  definitions.applyEngagementScores,
);
export const backfillPeople = internalMutation(definitions.backfillPeople);
export const finishLegacySharedFullResync = internalMutation(
  compat.finishLegacySharedFullResync,
);
