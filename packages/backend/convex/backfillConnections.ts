/**
 * Drain-only compatibility facade - keeps the pre-cutover
 * `internal.backfillConnections.*` paths and the runbook's historical
 * `backfillConnections:*` operator commands registered while old backfill
 * schedules drain. Canonical registration: migrations/backfillConnections.ts.
 * Removal gate: MIGRATION_RUNBOOK.md section 7.
 */
export {
  backfillSharedRecords,
  backfillUser,
  backfillUserEvents,
  backfillUserRows,
  backfillUserTail,
  enqueueConnectionBackfill,
  verifyParity,
} from "./migrations/backfillConnections";
