/**
 * Stable facade for storage maintenance. The recurring prunes + the
 * account-deletion purge live in `jobs/maintenance.ts`; the one-shot data
 * migrations live in `migrations/backfills.ts`. This facade keeps every
 * `internal.maintenance.*` path fixed — the crons and the functions' own
 * self-reschedules all reference it.
 */

import { internalMutation } from "./_generated/server";
import * as jobs from "./jobs/maintenance";
import * as migrations from "./migrations/backfills";

export const enqueueEventPrune = internalMutation(jobs.enqueueEventPrune);
export const pruneUserEvents = internalMutation(jobs.pruneUserEvents);
export const enqueueSharedEventPrune = internalMutation(
  jobs.enqueueSharedEventPrune,
);
export const pruneSharedCalendarEvents = internalMutation(
  jobs.pruneSharedCalendarEvents,
);
export const pruneRateLimits = internalMutation(jobs.pruneRateLimits);
export const purgeUserData = internalMutation(jobs.purgeUserData);

export const clearEventAttendees = internalMutation(
  migrations.clearEventAttendees,
);
export const migratePublicCalendarsToShared = internalMutation(
  migrations.migratePublicCalendarsToShared,
);
export const purgeNonSharedSharedEvents = internalMutation(
  migrations.purgeNonSharedSharedEvents,
);
