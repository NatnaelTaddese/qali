/**
 * Drain-only compatibility facade - keeps the pre-cutover api.assistant.* paths
 * registered while persisted scheduler entries and stale clients drain.
 * Canonical registration: domains/assistant/loop.ts. Removal gate:
 * MIGRATION_RUNBOOK.md section 7.
 */

export { confirmAction, sendMessage } from "./domains/assistant/loop";
