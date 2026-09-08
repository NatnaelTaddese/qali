/**
 * The service layer's one entry point for reminder writes. Keeps provider
 * names out of `domains/calendar/service.ts`: the rules come from the adapter
 * in hand, and the domain does the fitting.
 */

import {
  ReminderRulesError,
  fitRemindersToRules,
  type Reminder,
  type ReminderRules,
} from "@qali/domain/reminders";

import { ProviderError } from "./errors";

export type { ReminderRules };

/**
 * Fit a requested reminder write to what the adapter can hold, folding a
 * rules violation into a validation ProviderError so callers surface it the
 * same way as any other rejected write.
 */
export function fitReminderWrite(
  reminders: readonly Reminder[] | null | undefined,
  rules: ReminderRules,
  resolvedDefault: readonly number[],
): Reminder[] | null | undefined {
  try {
    return fitRemindersToRules(reminders, rules, resolvedDefault);
  } catch (error) {
    if (error instanceof ReminderRulesError) {
      throw new ProviderError("validation", error.message, { cause: error });
    }
    throw error;
  }
}
