/**
 * Drain-only compatibility facade - keeps the pre-cutover `api.waitlist.*` paths
 * registered while persisted scheduler entries and stale clients drain.
 * Canonical registration: domains/marketing/mutations.ts.
 * Removal gate: MIGRATION_RUNBOOK.md section 7.
 */

export { join } from "./domains/marketing/mutations";
