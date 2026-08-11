import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

// Refresh every registered user's Google calendar + contacts on an interval.
crons.interval(
  "sync google data",
  { minutes: 15 },
  internal.googleSync.enqueueSyncs,
  {},
);

crons.interval(
  "expire past booking requests",
  { minutes: 15 },
  internal.booking.expirePastBookings,
  {},
);

// Slow re-rank so recency decay + upcoming→past transitions settle on calendars
// that see no event changes. Event-driven recompute in runSyncForUser covers the
// common case; this is the idle-calendar safety net.
crons.interval(
  "refresh people ranking",
  { hours: 24 },
  internal.googleSync.enqueueEngagementRefresh,
  {},
);

// Cap the events table: delete events older than the sync horizon (365 days) so
// past events don't accumulate without bound. Daily is ample for a slow horizon.
crons.interval(
  "prune aged-out events",
  { hours: 24 },
  internal.maintenance.enqueueEventPrune,
  {},
);

// Same 180-day cap for the shared public-calendar events (holidays/birthdays).
crons.interval(
  "prune aged-out shared events",
  { hours: 24 },
  internal.maintenance.enqueueSharedEventPrune,
  {},
);

// Drop rate-limit counter rows whose window elapsed long ago, so the
// bookingRateLimits table doesn't accumulate a row per distinct key forever.
crons.interval(
  "prune stale rate limits",
  { hours: 24 },
  internal.maintenance.pruneRateLimits,
  {},
);

// Cap the assistant tables: delete conversations untouched for 30 days. The
// user-driven "new chat discards the prior" path handles the common case; this
// catches threads left behind rather than replaced.
crons.interval(
  "prune old assistant threads",
  { hours: 24 },
  internal.assistantMaintenance.pruneAgedThreads,
  {},
);

export default crons;
