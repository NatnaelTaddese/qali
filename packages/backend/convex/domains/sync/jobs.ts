/**
 * Canonical registration for the enqueueable sync job entry points. The legacy
 * googleSync drain queue registers the same definitions, so they stay
 * unregistered in engine.ts and are wrapped exactly once per module path here.
 */
import { internalAction, internalMutation } from "../../_generated/server";
import {
  backfillPeople as backfillPeopleDef,
  cleanupLegacyRemovedCalendarEvents as cleanupLegacyRemovedCalendarEventsDef,
  recomputeEngagement as recomputeEngagementDef,
  syncUser as syncUserDef,
} from "./engine";

export const syncUser = internalAction(syncUserDef);
export const recomputeEngagement = internalAction(recomputeEngagementDef);
export const backfillPeople = internalMutation(backfillPeopleDef);
export const cleanupLegacyRemovedCalendarEvents = internalMutation(
  cleanupLegacyRemovedCalendarEventsDef,
);
