/**
 * Stable facade for the assistant data layer (threads/messages/actions). Logic
 * in domains/assistant/data.ts; keeps api.assistantData.* / internal.assistantData.*
 * fixed.
 */

import { internalMutation, internalQuery, query } from "./_generated/server";
import * as definitions from "./domains/assistant/data";

export const isAvailable = query(definitions.isAvailable);
export const monthlyQuota = query(definitions.monthlyQuota);
export const listThreads = query(definitions.listThreads);
export const listMessages = query(definitions.listMessages);
export const listPendingActions = query(definitions.listPendingActions);

export const startTurn = internalMutation(definitions.startTurn);
export const getHistory = internalQuery(definitions.getHistory);
export const listEventsForAssistant = internalQuery(
  definitions.listEventsForAssistant,
);
export const listBookingBlocksForAssistant = internalQuery(
  definitions.listBookingBlocksForAssistant,
);
export const getRecurringSeriesVersion = internalQuery(
  definitions.getRecurringSeriesVersion,
);
export const flushText = internalMutation(definitions.flushText);
export const appendBlock = internalMutation(definitions.appendBlock);
export const setSuggestions = internalMutation(definitions.setSuggestions);
export const finishTurn = internalMutation(definitions.finishTurn);
export const failTurn = internalMutation(definitions.failTurn);
export const recordProposal = internalMutation(definitions.recordProposal);
export const getThreadActions = internalQuery(definitions.getThreadActions);
export const claimAction = internalMutation(definitions.claimAction);
export const settleClaimedAction = internalMutation(
  definitions.settleClaimedAction,
);
export const retryClaimedAction = internalMutation(
  definitions.retryClaimedAction,
);
export const releaseStaleAction = internalMutation(
  definitions.releaseStaleAction,
);
export const rejectAction = internalMutation(definitions.rejectAction);
