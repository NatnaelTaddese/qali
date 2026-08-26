/**
 * Drain-only compatibility facade - keeps the pre-cutover api.calendarSync.*
 * and internal.calendarSync.* paths registered while persisted scheduler
 * entries and stale clients drain.
 * Canonical registration: domains/sync/engine.ts and domains/sync/jobs.ts.
 * Removal gate: MIGRATION_RUNBOOK.md section 7.
 */
import { internalMutation } from "./_generated/server";
import { applyEngagementScores as applyEngagementScoresDef } from "./domains/sync/engine";
import { finishLegacySharedFullResync as finishLegacySharedFullResyncDef } from "./domains/sync/googleCompat";

export {
  applyEngagementScoreChunk,
  beginCalendarFullResync,
  beginContactsFullResync,
  beginSharedFullResync,
  claimEngagement,
  claimSharedCalendarSync,
  claimSyncLease,
  cleanupRemovedCalendarEvents,
  commitCalendarFullResync,
  commitContactsSync,
  commitSharedCalendarSync,
  enqueueEngagementRefresh,
  enqueueSyncs,
  ensureSyncState,
  finishEngagement,
  forceFullResync,
  getConnectionSyncState,
  heartbeatEngagement,
  heartbeatSharedCalendarLease,
  heartbeatSyncLease,
  listActiveConnections,
  listCalendarsForUser,
  listEventsPageForEngagement,
  markEngagementDirty,
  reconcileCalendars,
  recordSyncOutcome,
  releaseSharedCalendarLease,
  resetStaleEngagementScores,
  setCalendarSyncCursor,
  sweepLegacyOtherPeopleBatch,
  sweepStaleCalendarEventsBatch,
  sweepStaleContactsBatch,
  sweepStaleSharedEventsBatch,
  syncConnection,
  syncNow,
  upsertContactsPage,
  upsertEventsPage,
  upsertSharedEventsPage,
} from "./domains/sync/engine";

export {
  backfillPeople,
  cleanupLegacyRemovedCalendarEvents,
  recomputeEngagement,
  syncUser,
} from "./domains/sync/jobs";

// Old-shape queue targets whose only registration lives here - they wrap plain
// definitions and get no canonical path.
export const applyEngagementScores = internalMutation(applyEngagementScoresDef);
export const finishLegacySharedFullResync = internalMutation(
  finishLegacySharedFullResyncDef,
);
