# Hard Cutover Runbook

Production (currently on `main`) deploys this branch directly as a hard
cutover. There are no drain windows, parity phases, or expand/contract
choreography for function paths: the pre-reorg root facades and provider-named
sync modules are already deleted from source. Persisted references to old
paths are handled by a one-shot scheduler repoint migration (section 4) or
accepted as one-time failures that crons and lease recovery heal (section 5).
The data-model contraction is its own two-deploy procedure (section 8).

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

## 8. Data-model contraction

The contraction wipes all provider-derived data, resyncs it from providers
into the neutral model, and removes the legacy columns/indexes. It ships as
two commits and two deploys:

- **Deploy A** ("contraction + transitional schema"): all code is neutral-only
  — nothing reads or writes a legacy column. The schema is transitional: every
  legacy column stays declared as optional (so pre-wipe rows validate), the
  built staged indexes are activated, the two never-activated under-keyed
  `by_connection_and_providerEventId` indexes are deleted, and
  `calendars.providerSelected` + `recurringSeries.by_user` are added.
- **Deploy B** ("final schema"): the schema-only diff that deletes the legacy
  columns and indexes, the `syncState` and `connectionBackfillUsers` tables,
  `people.otherSyncGeneration`,
  `connectionSyncState.otherContactsBackfillRequired`, and tightens the
  transitional optionals to required. It also deletes
  `migrations/providerCutover.ts` and its itest (the migration has run by
  then).

### 8.1 Pre-flight

Run the section 1 preflight on commit C1. If
`bunx convex codegen --dry-run --typecheck enable` rejects the flag
combination on the installed CLI, fall back to plain `bunx convex codegen`
plus `bun run check-types`.

Cheap dashboard check before deploying: every `bookings` row with
`status: "pending"` and an `acceptOperationId` must have its matching
`calendarOperations` ledger row (`by_connection_and_key`). The runtime
ledger-reconstruction fallbacks were deleted in C1, so the ledger must
already be authoritative — repair any gap before proceeding.

### 8.2 Procedure

```sh
# 0. backup (mandatory — IS the rollback from step 3 on)
bunx convex export --prod --path qali-prod-<date>.zip
# 1. deploy A — from commit 37f3549 ("Contract to the provider-neutral data
#    model"), NOT the branch head: check it out, deploy, return to head
git checkout 37f3549
bunx convex deploy --typecheck enable --codegen enable \
  -m "contraction + transitional schema"
git checkout backend/reorg
# 2. scheduler repoint (section 4 tooling, if any legacy entries remain)
bunx convex run migrations/scheduledJobs:migrateExpireBookingSchedules '{}' --prod
# 3. wipe + resync — run IMMEDIATELY after deploy A: between A and the wipe,
#    neutral-only reads hide legacy rows, so the app looks empty-ish until
#    resync completes
bunx convex run migrations/providerCutover:start '{}' --prod
# 4. watch dashboard logs until fanOutResync reports done and per-user syncs
#    complete (~minutes at current user counts)
# 5. verify (8.3), then deploy B from the branch head (the final-schema commit)
bunx convex deploy --typecheck enable --codegen enable -m "final schema"
```

The migration chain is resumable: any phase can be re-run from a null cursor.
Once `fanOutResync` has run, resume the failed phase only — never restart
from `start`, which would re-null freshly re-pointed booking targets and
re-wipe synced data (safe, but a pointless second outage).

### 8.3 Verify (between wipe and deploy B)

- `api.healthCheck.get` healthy; Better Auth login works.
- Per-user sync completes: dashboard function logs quiet after one cycle.
- Calendar range read shows events; one event create/edit round-trips.
- A booking request auto-resolves its page target (primary-target self-heal).
- Guest picker (people directory) repopulates.
- Row counts are the right order of magnitude against pre-wipe counts.
- No retained row still carries a legacy field. Deploy B enforces this: its
  schema validation fails cleanly on any leftover legacy value. A B-push
  failure is the designed gate, not an error to force past — re-run the
  relevant clear phase of `providerCutover`, then retry deploy B.

### 8.4 Expected one-time noise

- In-flight pre-A syncs fail once with `StaleSyncAttemptError` or validation
  errors; the 15-minute cron and lease TTLs heal them.
- Persisted scheduler entries addressing functions deleted at A (legacy
  cleanup/backfill functions) or whose argument validators changed fail once
  when they fire. Expected, harmless, non-repeating.
- Pending assistant proposals are expired by the migration with a clear
  "please re-ask" result.

### 8.5 Documented accepted losses

- Local calendar visibility (`calendars.selected`) re-seeds from the
  provider's own selection (`providerSelected`) — local-only toggles made
  before the wipe are lost.
- Pending assistant proposals are expired (above).
- Non-primary booking-page targets are cleared; the fallback re-points pages
  at the primary calendar, and hosts re-choose any non-default target.

### 8.6 Recovery notes

- A booking page found with BOTH targets set but dangling (pointing at a
  calendar that no longer exists — e.g. self-healed onto a calendar created
  during the A→wipe window) makes `bookingPageTarget` throw with no
  self-heal. Remedy: re-run `migrations/providerCutover:clearBookingPageTargets`
  (nulls the pair; the fallback then re-resolves) — never a manual partial
  edit and never a forced deploy.
- Rollback before `providerCutover:start`: redeploy `main` (code paths only —
  no data restore needed).
- Rollback after `providerCutover:start`: redeploy `main` AND restore the
  step-0 backup via import. Never a partial restore; never restore by
  deleting neutral production data.
