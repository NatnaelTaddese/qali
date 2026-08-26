# Hard Cutover Runbook

Production (currently on `main`) deploys this branch directly as a hard
cutover. There are no drain windows, parity phases, or expand/contract
choreography for function paths: the pre-reorg root facades and provider-named
sync modules are already deleted from source. Persisted references to old
paths are handled by a one-shot scheduler repoint migration (section 4) or
accepted as one-time failures that crons and lease recovery heal (section 5).
The data-model contraction is a separate later stage (section 8).

Run workspace `bun run` commands from the repository root. Run `bunx convex`
commands from `packages/backend`. These commands document production work; this
source change does not run a deploy or backfill by itself.

## 1. Read-only preflight

Confirm a clean, reviewed diff. Never use `--push` or a deploy command for
source verification.

```sh
git status --short
bun run test
bun run check-types
bun run build
```

Run the Convex generator in read-only mode from `packages/backend`. It prints
generated output, typechecks the schema/functions, does not write `_generated`,
does not prompt for a deploy, and does not modify any deployment:

```sh
bunx convex codegen --dry-run --typecheck enable
```

Stop if tests or codegen fail, the reviewed schema contains an unexpected
deletion, or the section 2 backup is missing. Do not set a production
deployment for read-only source verification.

## 2. Mandatory production backup

A fresh production snapshot/export taken immediately before the deploy is
mandatory, not advisory. The coming data-contraction stage wipes derived data
and resyncs from providers; from that point on, this backup IS the rollback.
Take the export, verify the archive is readable, and record its timestamp
before proceeding:

```sh
bunx convex export --prod --path qali-prod-<date>.zip
```

A dashboard snapshot backup of the production deployment is an acceptable
alternative; either way, do not deploy without a backup taken today.

## 3. Deploy

This is an actual production deploy, not verification. Confirm the target in a
separate operator step, then run the single cutover deploy:

```sh
export CONVEX_DEPLOYMENT="prod:<production-deployment>"
bunx convex deploy --typecheck enable --codegen enable \
  --message "hard cutover to canonical domains/jobs/migrations paths"
```

## 4. Repoint persisted booking-expiry schedules

Run immediately after the deploy. Pre-cutover `requestBooking` queued legacy
`booking:expireBooking` scheduler entries as far as 365 days out, so they
cannot passively drain. The repoint migration cancels each pending legacy
entry by id — cancellation works even though the old function no longer
exists — and re-schedules `internal.domains.booking.mutations.expireBooking`
at the identical time with the identical args.

Sweep before, to record the pending legacy counts (feed `continueCursor` back
in until `isDone`, summing counts):

```sh
bunx convex run migrations/scheduledJobs:listPendingFunctionNames '{}' --prod
```

Optionally rehearse with `'{"dryRun":true}'`, then run for real:

```sh
bunx convex run migrations/scheduledJobs:migrateExpireBookingSchedules '{}' --prod
```

Sweep again after the self-reschedule chain completes: no pending name may
still address a deleted path. Re-running from a null cursor is a no-op for
entries migrated earlier. The 15-minute `expirePastBookings` cron covers the
window between the deploy and the migration run, and any entry the migration
misses.

## 5. Expected one-time noise

The following failures are expected exactly once around the cutover and are
not rollback triggers:

- In-flight pre-cutover sync/calendar actions and any queued
  `internal.googleSync.*` / `internal.<old-module>.*` jobs fail once with
  missing-function errors. Sync self-heals through the 15-minute sync cron and
  lease-TTL takeover (10-minute sync and engagement leases, 5-minute
  shared-calendar lease).
- Stored old-shape assistant proposals cannot be confirmed; they age out with
  the 30-day thread prune.
- Stale SPA tabs keep calling deleted public paths until reloaded.

None of these repeat after the first post-deploy sync cycle. Missing-function
errors that persist past that point are a defect, not cutover noise.

## 6. Verify

- `api.healthCheck.get` returns healthy.
- Better Auth login.
- Calendar range reads.
- One manual sync (`api.domains.sync.engine.syncNow`).
- One event write.
- Booking request and acceptance.
- Dashboard cron registration shows only canonical `internal.domains.*` /
  `internal.jobs.maintenance.*` targets.
- Function error logs are quiet after the first sync cycle.

## 7. Rollback

Redeploy `main`; that restores the old registered paths. No data restore is
needed at this stage — the cutover changes function paths, not stored data.
Entries already repointed in section 4 address canonical paths that `main`
does not register; the 15-minute booking-expiry cron covers those bookings
until the cutover is redeployed. Never restore by deleting neutral production
data.

## 8. Data-model contraction (separate stage)

The wipe-derived-data-and-resync plus schema contraction ships as its own
stage with its own rehearsed procedure, which will replace or extend this
document. The section 2 backup is the rollback for that stage. Until it lands,
no schema field, table, or index is removed, and the following legacy storage
is intentionally retained — all of it to be removed by the contraction:

- `syncState` and its Google contact cursors/generations/lease fields
- Calendar/event aliases including `googleCalendarId`, `googleSelected`,
  `syncToken`, `calendarId`, `googleEventId`, `googleUpdatedMs`, `colorId`,
  `transparency`, `recurringEventId`, and `hangoutLink`
- Shared-calendar/shared-event and recurring-series Google identity/cursor fields
- Contact aliases `resourceName`, `googleEtag`, and legacy generations
- Booking aliases `googleEventId`, `calendarId`, legacy acceptance lease/state,
  and fallback behavior when neutral target ids are absent
- Legacy identity/range indexes used by fallback reads, plus the under-keyed
  `by_connection_and_providerEventId` indexes until every reader uses the
  calendar-keyed replacements
- Stored legacy assistant/calendar action DTO normalization, and raw and
  wrapped Google cursor decoding

At every contraction step, unexpected missing-function errors, parity
mismatches, duplicate provider identities, elevated sync/booking failures, or
unresolved neutral ids are rollback gates. Restore code/read compatibility
first; never restore by deleting neutral production data.
