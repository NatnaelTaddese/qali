# Compatibility Baseline

Snapshot of the callable/scheduled backend surface as of the start of the provider-ready
refactor (branch `fix/assistant-enhancements`). Later stages diff `_generated/api.d.ts` and this
file to prove no public wire contract or scheduled reference was silently broken.

Expected changes over the course of the refactor are limited to:
- adding `api.calendarSync.syncNow` (provider-neutral facade; `api.googleSync.syncNow` retained),
- additive optional storage fields on existing tables,
- the honest `Id<"events"> | Id<"sharedEvents">` id union on shared-event reads.

Everything else below must remain callable at the same path with the same argument shapes.

## Public API surface (`api.*`)

- `api.assistant.confirmAction`, `api.assistant.sendMessage`
- `api.assistantData.isAvailable`, `api.assistantData.listMessages`, `api.assistantData.listPendingActions`, `api.assistantData.listThreads`, `api.assistantData.monthlyQuota`
- `api.assistantMaintenance.deleteThread`
- `api.auth.getCurrentUser`
- `api.booking.acceptBooking`, `api.booking.bookingPageDefaults`, `api.booking.checkSlugAvailable`, `api.booking.getBookingByToken`, `api.booking.getMyBookingPage`, `api.booking.getPublicPage`, `api.booking.listMyBookings`, `api.booking.listMyOverrides`, `api.booking.listPendingBookings`, `api.booking.listSlots`, `api.booking.rejectBooking`, `api.booking.requestBooking`, `api.booking.setOverride`, `api.booking.upsertBookingPage`
- `api.calendar.createEvent`, `api.calendar.deleteEvent`, `api.calendar.getEventById`, `api.calendar.getEventRecurrence`, `api.calendar.listCalendars`, `api.calendar.listEvents`, `api.calendar.listEventsInRange`, `api.calendar.refreshEventRecurrence`, `api.calendar.respondToEvent`, `api.calendar.setCalendarSelected`, `api.calendar.updateEvent`, `api.calendar.updateEventTime`
- `api.contacts.listContacts`
- `api.googleSync.syncNow`
- `api.healthCheck.get`
- `api.notifications.clearAll`, `api.notifications.dismiss`, `api.notifications.list`, `api.notifications.markAllRead`, `api.notifications.markRead`, `api.notifications.unreadCount`
- `api.people.listPeople`
- `api.privateData.get`
- `api.waitlist.join`

## Scheduled / cross-called internal references (`internal.*`)

These are invoked from crons, `ctx.scheduler.*`, or `ctx.run{Query,Mutation,Action}` and must keep
resolving. The long-horizon one is **`internal.booking.expireBooking`** (`runAt(endMs, …)` in
`requestBooking`) — never retire before its full 365-day queue horizon.

- assistantData: appendBlock, claimAction, failTurn, finishTurn, flushText, getHistory, getRecurringSeriesVersion, getThreadActions, listBookingBlocksForAssistant, listEventsForAssistant, recordProposal, rejectAction, releaseStaleAction, retryClaimedAction, setSuggestions, settleClaimedAction, startTurn
- assistantMaintenance: pruneAgedThreads
- booking: claimBookingAcceptance, **expireBooking**, expirePastBookings, getBookingContext, markAccepted, releaseBookingAcceptance
- calendar: deleteEventRow, getEventContext, getPrimaryCalendarId, listSharedEventsForAssistant, upsertEvent, upsertRecurringSeries
- googleSync: applyEngagementScores, backfillPeople, beginCalendarFullResync, beginContactsFullResync, claimSharedCalendarSync, claimSyncLease, cleanupRemovedCalendarEvents, clearCalendarEventsBatch, clearSharedCalendarEventsBatch, commitCalendarFullResync, enqueueEngagementRefresh, enqueueSyncs, ensureSyncState, getSyncState, listCalendarsForUser, listEventsPageForEngagement, recomputeEngagement, reconcileCalendars, recordSyncOutcome, releaseSharedCalendarLease, setCalendarSyncToken, setContactsSync, setOtherContactsSync, setSharedCalendarSynced, sweepStaleCalendarEventsBatch, sweepStaleContactsBatch, sweepStaleOtherPeopleBatch, syncUser, upsertContactsPage, upsertEventsPage, upsertOtherContactsPage, upsertSharedEventsPage
- maintenance: clearEventAttendees, enqueueEventPrune, enqueueSharedEventPrune, migratePublicCalendarsToShared, pruneRateLimits, pruneSharedCalendarEvents, pruneUserEvents, purgeNonSharedSharedEvents, purgeUserData
- notifications: continueClearAll, continueMarkAllRead

## Test baseline

`fix/assistant-enhancements`: 111 unit tests (`bun test convex`), 8 integration tests
(`vitest run`, `*.itest.ts`), passing `check-types` and workspace build.
