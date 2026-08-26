/**
 * Drain-only compatibility facade - keeps the pre-cutover api.assistantData.* /
 * internal.assistantData.* paths registered while persisted scheduler entries
 * and stale clients drain.
 * Canonical registration: domains/assistant/data.ts. Removal gate:
 * MIGRATION_RUNBOOK.md section 7.
 */

export {
  appendBlock,
  claimAction,
  failTurn,
  finishTurn,
  flushText,
  getHistory,
  getRecurringSeriesVersion,
  getThreadActions,
  isAvailable,
  listBookingBlocksForAssistant,
  listEventsForAssistant,
  listMessages,
  listPendingActions,
  listThreads,
  monthlyQuota,
  recordProposal,
  rejectAction,
  releaseStaleAction,
  retryClaimedAction,
  setSuggestions,
  settleClaimedAction,
  startTurn,
} from "./domains/assistant/data";
