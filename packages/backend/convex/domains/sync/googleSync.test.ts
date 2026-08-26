import { expect, test } from "vitest";

import { internal } from "../../_generated/api";

test("retains every pre-cutover googleSync cross-call target", () => {
  const targets = [
    internal.googleSync.getSyncState,
    internal.googleSync.ensureSyncState,
    internal.googleSync.claimSyncLease,
    internal.googleSync.recordSyncOutcome,
    internal.googleSync.listCalendarsForUser,
    internal.googleSync.reconcileCalendars,
    internal.googleSync.clearCalendarEventsBatch,
    internal.googleSync.cleanupRemovedCalendarEvents,
    internal.googleSync.beginCalendarFullResync,
    internal.googleSync.upsertEventsPage,
    internal.googleSync.sweepStaleCalendarEventsBatch,
    internal.googleSync.commitCalendarFullResync,
    internal.googleSync.setCalendarSyncToken,
    internal.googleSync.claimSharedCalendarSync,
    internal.googleSync.releaseSharedCalendarLease,
    internal.googleSync.clearSharedCalendarEventsBatch,
    internal.googleSync.upsertSharedEventsPage,
    internal.googleSync.setSharedCalendarSynced,
    internal.googleSync.beginContactsFullResync,
    internal.googleSync.upsertContactsPage,
    internal.googleSync.upsertOtherContactsPage,
    internal.googleSync.sweepStaleContactsBatch,
    internal.googleSync.sweepStaleOtherPeopleBatch,
    internal.googleSync.setContactsSync,
    internal.googleSync.setOtherContactsSync,
    internal.googleSync.listEventsPageForEngagement,
    internal.googleSync.applyEngagementScores,
    internal.googleSync.syncUser,
    internal.googleSync.recomputeEngagement,
    internal.googleSync.enqueueSyncs,
    internal.googleSync.enqueueEngagementRefresh,
    internal.googleSync.backfillPeople,
  ];
  expect(targets.every(Boolean)).toBe(true);
});
