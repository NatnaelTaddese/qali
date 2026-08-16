/**
 * Stable facade for the Google sync engine.
 *
 * The engine itself — the crown-jewels sync loop (generation-sweep, lease
 * mutual-exclusion, adaptive cadence, snapshot replacement) — lives in
 * `domains/sync/engine.ts`. It was relocated whole, byte-for-byte, rather than
 * hand-split, because a transcription slip in that file would be a silent sync
 * corruption. This facade keeps every `api.googleSync.*` / `internal.googleSync.*`
 * path fixed, along with the helpers `calendarOps` and `calendarSync` import
 * (`syncOneCalendar`, `CALENDAR_HISTORY_MS`, `syncNowForCurrentUser`).
 */

import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import * as definitions from "./domains/sync/engine";

export {
  CALENDAR_FUTURE_MS,
  CALENDAR_HISTORY_MS,
  syncNowForCurrentUser,
  syncOneCalendar,
  syncOneSharedCalendar,
} from "./domains/sync/engine";

export const syncNow = action(definitions.syncNow);
export const syncUser = internalAction(definitions.syncUser);
export const forceFullResync = internalAction(definitions.forceFullResync);
export const backfillPeople = internalMutation(definitions.backfillPeople);
export const enqueueEngagementRefresh = internalMutation(
  definitions.enqueueEngagementRefresh,
);
export const enqueueSyncs = internalMutation(definitions.enqueueSyncs);
export const getSyncState = internalQuery(definitions.getSyncState);
export const ensureSyncState = internalMutation(definitions.ensureSyncState);
export const claimSyncLease = internalMutation(definitions.claimSyncLease);
export const recordSyncOutcome = internalMutation(
  definitions.recordSyncOutcome,
);
export const listCalendarsForUser = internalQuery(
  definitions.listCalendarsForUser,
);
export const reconcileCalendars = internalMutation(
  definitions.reconcileCalendars,
);
export const clearCalendarEventsBatch = internalMutation(
  definitions.clearCalendarEventsBatch,
);
export const cleanupRemovedCalendarEvents = internalMutation(
  definitions.cleanupRemovedCalendarEvents,
);
export const beginCalendarFullResync = internalMutation(
  definitions.beginCalendarFullResync,
);
export const sweepStaleCalendarEventsBatch = internalMutation(
  definitions.sweepStaleCalendarEventsBatch,
);
export const commitCalendarFullResync = internalMutation(
  definitions.commitCalendarFullResync,
);
export const setCalendarSyncToken = internalMutation(
  definitions.setCalendarSyncToken,
);
export const claimSharedCalendarSync = internalMutation(
  definitions.claimSharedCalendarSync,
);
export const releaseSharedCalendarLease = internalMutation(
  definitions.releaseSharedCalendarLease,
);
export const clearSharedCalendarEventsBatch = internalMutation(
  definitions.clearSharedCalendarEventsBatch,
);
export const setSharedCalendarSynced = internalMutation(
  definitions.setSharedCalendarSynced,
);
export const upsertSharedEventsPage = internalMutation(
  definitions.upsertSharedEventsPage,
);
export const setContactsSync = internalMutation(definitions.setContactsSync);
export const setOtherContactsSync = internalMutation(
  definitions.setOtherContactsSync,
);
export const beginContactsFullResync = internalMutation(
  definitions.beginContactsFullResync,
);
export const sweepStaleContactsBatch = internalMutation(
  definitions.sweepStaleContactsBatch,
);
export const sweepStaleOtherPeopleBatch = internalMutation(
  definitions.sweepStaleOtherPeopleBatch,
);
export const upsertEventsPage = internalMutation(definitions.upsertEventsPage);
export const upsertContactsPage = internalMutation(
  definitions.upsertContactsPage,
);
export const upsertOtherContactsPage = internalMutation(
  definitions.upsertOtherContactsPage,
);
export const listEventsPageForEngagement = internalQuery(
  definitions.listEventsPageForEngagement,
);
export const applyEngagementScores = internalMutation(
  definitions.applyEngagementScores,
);
export const recomputeEngagement = internalAction(
  definitions.recomputeEngagement,
);
