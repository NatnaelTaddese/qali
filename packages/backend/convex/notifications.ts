/**
 * Drain-only compatibility facade - keeps the pre-cutover `api.notifications.*`
 * and `internal.notifications.*` paths registered while persisted scheduler
 * entries and stale clients drain.
 * Canonical registration: domains/notifications/{queries,mutations}.ts.
 * Removal gate: MIGRATION_RUNBOOK.md section 7.
 */

export {
  clearAll,
  continueClearAll,
  continueMarkAllRead,
  dismiss,
  markAllRead,
  markRead,
} from "./domains/notifications/mutations";
export { list, unreadCount } from "./domains/notifications/queries";
