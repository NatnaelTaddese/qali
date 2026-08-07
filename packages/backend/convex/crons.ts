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

export default crons;
