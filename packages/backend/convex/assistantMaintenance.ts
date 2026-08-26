/**
 * Drain-only compatibility facade - keeps the pre-cutover api.assistantMaintenance.* /
 * internal.assistantMaintenance.* paths registered while persisted scheduler
 * entries and stale clients drain.
 * Canonical registration: domains/assistant/maintenance.ts. Removal gate:
 * MIGRATION_RUNBOOK.md section 7.
 */

export { deleteThread, pruneAgedThreads } from "./domains/assistant/maintenance";
