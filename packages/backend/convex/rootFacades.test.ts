/**
 * Registration guard for the drain-only root facades. Each block enumerates
 * every generated function reference its facade file must keep registered, so
 * the typecheck breaks if a facade stops exporting one. Deleting a facade file
 * must be accompanied by deleting its block here in the same commit, per the
 * drain procedure in MIGRATION_RUNBOOK.md section 7. calendarSync.ts removal
 * is coupled to googleSync.ts through finishLegacySharedFullResync, so its
 * block leaves only in that shared wave-2 deploy.
 */
import { describe, expect, test } from "vitest";

import { api, internal } from "./_generated/api";

describe("assistant.ts facade", () => {
  test("retains every pre-cutover assistant target", () => {
    const targets = [api.assistant.sendMessage, api.assistant.confirmAction];
    expect(targets.every(Boolean)).toBe(true);
  });
});

describe("assistantData.ts facade", () => {
  test("retains every pre-cutover assistantData target", () => {
    const targets = [
      api.assistantData.isAvailable,
      api.assistantData.monthlyQuota,
      api.assistantData.listThreads,
      api.assistantData.listMessages,
      api.assistantData.listPendingActions,
      internal.assistantData.startTurn,
      internal.assistantData.getHistory,
      internal.assistantData.listEventsForAssistant,
      internal.assistantData.listBookingBlocksForAssistant,
      internal.assistantData.getRecurringSeriesVersion,
      internal.assistantData.flushText,
      internal.assistantData.appendBlock,
      internal.assistantData.setSuggestions,
      internal.assistantData.finishTurn,
      internal.assistantData.failTurn,
      internal.assistantData.recordProposal,
      internal.assistantData.getThreadActions,
      internal.assistantData.claimAction,
      internal.assistantData.settleClaimedAction,
      internal.assistantData.retryClaimedAction,
      internal.assistantData.releaseStaleAction,
      internal.assistantData.rejectAction,
    ];
    expect(targets.every(Boolean)).toBe(true);
  });
});

describe("assistantMaintenance.ts facade", () => {
  test("retains every pre-cutover assistantMaintenance target", () => {
    const targets = [
      api.assistantMaintenance.deleteThread,
      internal.assistantMaintenance.pruneAgedThreads,
    ];
    expect(targets.every(Boolean)).toBe(true);
  });
});

describe("backfillConnections.ts facade", () => {
  test("retains every pre-cutover backfillConnections target", () => {
    const targets = [
      internal.backfillConnections.enqueueConnectionBackfill,
      internal.backfillConnections.backfillUser,
      internal.backfillConnections.backfillUserRows,
      internal.backfillConnections.backfillUserEvents,
      internal.backfillConnections.backfillUserTail,
      internal.backfillConnections.backfillSharedRecords,
      internal.backfillConnections.verifyParity,
    ];
    expect(targets.every(Boolean)).toBe(true);
  });
});

describe("booking.ts facade", () => {
  test("retains every pre-cutover booking target", () => {
    const targets = [
      api.booking.getMyBookingPage,
      api.booking.checkSlugAvailable,
      api.booking.bookingPageDefaults,
      api.booking.listMyOverrides,
      api.booking.listMyBookings,
      api.booking.listPendingBookings,
      api.booking.getPublicPage,
      api.booking.listSlots,
      api.booking.getBookingByToken,
      api.booking.upsertBookingPage,
      api.booking.setOverride,
      api.booking.requestBooking,
      api.booking.rejectBooking,
      api.booking.acceptBooking,
      internal.booking.getBookingContext,
      internal.booking.expireBooking,
      internal.booking.expirePastBookings,
      internal.booking.markAccepted,
      internal.booking.claimBookingAcceptance,
      internal.booking.claimScheduledBookingAcceptance,
      internal.booking.releaseBookingAcceptance,
      internal.booking.rejectBookingForHost,
      internal.booking.reconcileBookingAcceptance,
    ];
    expect(targets.every(Boolean)).toBe(true);
  });
});

describe("calendar.ts facade", () => {
  test("retains every pre-cutover calendar target", () => {
    const targets = [
      api.calendar.listCalendars,
      api.calendar.listEventsInRange,
      api.calendar.getEventById,
      api.calendar.getEventRecurrence,
      api.calendar.setCalendarSelected,
      api.calendar.createEvent,
      api.calendar.refreshEventRecurrence,
      api.calendar.updateEventTime,
      api.calendar.updateEvent,
      api.calendar.respondToEvent,
      api.calendar.deleteEvent,
      internal.calendar.listSharedEventsForAssistant,
      internal.calendar.getCalendarConnectionForAdapter,
      internal.calendar.getEventContext,
      internal.calendar.resolveCreateTarget,
      internal.calendar.resolveEventWriteTarget,
      internal.calendar.claimCalendarOperation,
      internal.calendar.settleCalendarOperation,
      internal.calendar.mirrorProviderEvent,
      internal.calendar.deleteProviderEventMirror,
      internal.calendar.upsertProviderRecurringSeries,
      // In-flight legacy shims registered only in the facade file.
      internal.calendar.getPrimaryCalendarId,
      internal.calendar.deleteEventRow,
      internal.calendar.upsertEvent,
      internal.calendar.upsertRecurringSeries,
    ];
    expect(targets.every(Boolean)).toBe(true);
  });
});

describe("calendarSync.ts facade", () => {
  test("retains every pre-cutover calendarSync target", () => {
    const targets = [
      api.calendarSync.syncNow,
      internal.calendarSync.syncConnection,
      internal.calendarSync.forceFullResync,
      internal.calendarSync.listActiveConnections,
      internal.calendarSync.getConnectionSyncState,
      internal.calendarSync.ensureSyncState,
      internal.calendarSync.claimSyncLease,
      internal.calendarSync.heartbeatSyncLease,
      internal.calendarSync.recordSyncOutcome,
      internal.calendarSync.enqueueSyncs,
      internal.calendarSync.listCalendarsForUser,
      internal.calendarSync.reconcileCalendars,
      internal.calendarSync.cleanupRemovedCalendarEvents,
      internal.calendarSync.beginCalendarFullResync,
      internal.calendarSync.upsertEventsPage,
      internal.calendarSync.sweepStaleCalendarEventsBatch,
      internal.calendarSync.commitCalendarFullResync,
      internal.calendarSync.setCalendarSyncCursor,
      internal.calendarSync.claimSharedCalendarSync,
      internal.calendarSync.beginSharedFullResync,
      internal.calendarSync.heartbeatSharedCalendarLease,
      internal.calendarSync.releaseSharedCalendarLease,
      internal.calendarSync.upsertSharedEventsPage,
      internal.calendarSync.sweepStaleSharedEventsBatch,
      internal.calendarSync.commitSharedCalendarSync,
      internal.calendarSync.beginContactsFullResync,
      internal.calendarSync.upsertContactsPage,
      internal.calendarSync.sweepStaleContactsBatch,
      internal.calendarSync.sweepLegacyOtherPeopleBatch,
      internal.calendarSync.commitContactsSync,
      internal.calendarSync.listEventsPageForEngagement,
      internal.calendarSync.markEngagementDirty,
      internal.calendarSync.claimEngagement,
      internal.calendarSync.heartbeatEngagement,
      internal.calendarSync.applyEngagementScoreChunk,
      internal.calendarSync.resetStaleEngagementScores,
      internal.calendarSync.finishEngagement,
      internal.calendarSync.enqueueEngagementRefresh,
      internal.calendarSync.syncUser,
      internal.calendarSync.recomputeEngagement,
      internal.calendarSync.backfillPeople,
      internal.calendarSync.cleanupLegacyRemovedCalendarEvents,
      // Old-shape queue targets registered only in the facade file.
      internal.calendarSync.applyEngagementScores,
      internal.calendarSync.finishLegacySharedFullResync,
    ];
    expect(targets.every(Boolean)).toBe(true);
  });
});

describe("maintenance.ts facade", () => {
  test("retains every pre-cutover maintenance target", () => {
    const targets = [
      internal.maintenance.enqueueEventPrune,
      internal.maintenance.pruneUserEvents,
      internal.maintenance.enqueueSharedEventPrune,
      internal.maintenance.pruneSharedCalendarEvents,
      internal.maintenance.pruneRateLimits,
      internal.maintenance.pruneCalendarOperations,
      internal.maintenance.purgeUserData,
      internal.maintenance.clearEventAttendees,
      internal.maintenance.migratePublicCalendarsToShared,
      internal.maintenance.purgeNonSharedSharedEvents,
    ];
    expect(targets.every(Boolean)).toBe(true);
  });
});

describe("notifications.ts facade", () => {
  test("retains every pre-cutover notifications target", () => {
    const targets = [
      api.notifications.list,
      api.notifications.unreadCount,
      api.notifications.markRead,
      api.notifications.markAllRead,
      api.notifications.dismiss,
      api.notifications.clearAll,
      internal.notifications.continueMarkAllRead,
      internal.notifications.continueClearAll,
    ];
    expect(targets.every(Boolean)).toBe(true);
  });
});

describe("people.ts facade", () => {
  test("retains every pre-cutover people target", () => {
    const targets = [api.people.listPeople];
    expect(targets.every(Boolean)).toBe(true);
  });
});

describe("waitlist.ts facade", () => {
  test("retains every pre-cutover waitlist target", () => {
    const targets = [api.waitlist.join];
    expect(targets.every(Boolean)).toBe(true);
  });
});
