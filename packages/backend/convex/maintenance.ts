/**
 * Drain-only compatibility facade - keeps the pre-cutover `internal.maintenance.*`
 * paths (formerly also the crons' target) registered while persisted scheduler
 * entries and stale clients drain. Canonical registration: jobs/maintenance.ts
 * and migrations/backfills.ts. Removal gate: MIGRATION_RUNBOOK.md section 7.
 */

export {
  enqueueEventPrune,
  enqueueSharedEventPrune,
  pruneCalendarOperations,
  pruneRateLimits,
  pruneSharedCalendarEvents,
  pruneUserEvents,
  purgeUserData,
} from "./jobs/maintenance";
export {
  clearEventAttendees,
  migratePublicCalendarsToShared,
  purgeNonSharedSharedEvents,
} from "./migrations/backfills";
