/**
 * Drain-only compatibility facade - keeps the pre-cutover `api.people.*` paths
 * registered while persisted scheduler entries and stale clients drain.
 * Canonical registration: domains/people/queries.ts.
 * Removal gate: MIGRATION_RUNBOOK.md section 7.
 */

export { listPeople } from "./domains/people/queries";
