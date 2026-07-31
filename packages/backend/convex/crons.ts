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

export default crons;
