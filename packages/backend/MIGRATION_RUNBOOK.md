# Connection Migration Runbook

Run workspace `bun run` commands from the repository root. Run `bunx convex`
commands from `packages/backend`. These commands document production work; this
source change does not run a deploy or backfill.

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
deletion, or production does not have a current backup/export. Do not set a
production deployment for read-only source verification.

## 2. Deploy expand/cutover code

This is an actual production deploy, not verification. Confirm the target in a
separate operator step, then deploy the additive schema, dual writes, neutral
connection sync, staged indexes, backfill functions, and all queue-drain shims.
The same deploy carries the canonical `domains/`/`jobs/`/`migrations/`
registrations alongside the root facade re-exports (dual registration) and the
repointed crons:

```sh
export CONVEX_DEPLOYMENT="prod:<production-deployment>"
bunx convex deploy --typecheck enable --codegen enable \
  --message "expand provider connections and retain queue-drain shims"
```

Verify the deployment health check, Better Auth login, calendar range reads,
one manual sync, one event write, booking request/acceptance, cron registration,
and function error logs. Confirm the dashboard cron registration shows the
canonical `internal.jobs.maintenance.*` / `internal.domains.*` targets, not the
root facade paths. Roll back application code if behavior regresses, but do not
remove additive fields, indexes, or compatibility targets.

## 3. Backfill

Start exactly one resumable discovery run. Re-running is safe and creates a new
run id, but do not start overlapping runs intentionally.

```sh
bunx convex run migrations/backfillConnections:enqueueConnectionBackfill '{}' --prod
```

Wait until scheduled functions are drained and every
`connectionBackfillUsers.completedAt` is populated. The pipeline discovers
users, creates/repairs their Google connection and connection sync state,
backfills calendars, events, recurring series, booking targets/bookings,
contacts, shared calendars/events, and operation-ledger rows.

Pause on function failures, duplicate Google connections, unresolved local
calendar ids, or a growing scheduled-function backlog. Fix forward and rerun;
do not contract storage to work around a partial backfill.

## 4. Verify exact parity

Verify every phase below. Start with `cursor: null`; while `isDone` is false,
repeat with the returned `continueCursor`. A phase passes only when every page
has `mismatches: 0`.

```sh
bunx convex run migrations/backfillConnections:verifyParity \
  '{"phase":"events","cursor":null,"numItems":100}' --prod
```

Required phases, in order:

```text
syncState
calendarConnections
connectionSyncState
calendars
events
recurringSeries
bookingPages
bookings
contacts
people
sharedCalendars
sharedEvents
calendarOperations
connectionBackfillUsers
```

Also verify that connection sync leases settle, provider cursors advance, old
and neutral identity columns agree, booking operations reconcile, and a full
provider sync does not create duplicate events or contacts. Any mismatch blocks
index activation and contraction.

The `contacts` phase validates one exact source claim for every saved contact
identity/email, including contacts that share an email. The `people` phase
validates that each `connection`/`other` source has a provider-contact claim and
backing `contacts`/`otherContactSources` row. Legacy Other Contacts cannot be
reconstructed from `people` alone: backfill clears their cursor and reports
`otherContactsFullSyncRequired` until a safe full Other Contacts sync completes.
Rerunning the `people` phase also removes historical `connection` claims and
sources whose saved contact no longer carries that email; another contact's
claim for the same email remains authoritative.

## 5. Activate staged indexes

Wait for every index below to show a completed/ready backfill in the Convex
dashboard:

- `calendars.by_connection_and_providerCalendarId`
- `events.by_connection_and_providerEventId`
- `events.by_connection_and_localCalendarId_and_providerEventId`
- `events.by_connection_and_localCalendarId_and_providerSeriesId`
- `events.by_connection_and_localCalendarId_and_endMs`
- `sharedEvents.by_provider_and_providerCalendarId_and_providerEventId`
- `sharedEvents.by_provider_and_providerCalendarId_and_startMs`
- `sharedEvents.by_provider_and_providerCalendarId_and_endMs`
- `sharedCalendars.by_provider_and_providerCalendarId`
- `recurringSeries.by_connection_and_providerEventId`
- `recurringSeries.by_connection_and_localCalendarId_and_providerEventId`
- `contacts.by_connection_and_providerContactId`
- `bookingPages.by_targetConnectionId_and_targetCalendarId`
- `bookings.by_targetConnectionId_and_targetCalendarId_and_startMs`
- `personSourceClaims.by_connection_and_source_and_providerContactId_and_email`

Initial code must use the legacy Google indexes and validate neutral ownership
in code; Microsoft remains unavailable during this phase. In a dedicated source
change, remove `staged: true` from those declarations and run the read-only
preflight. Then confirm the production target and perform the actual activation
deploy:

```sh
export CONVEX_DEPLOYMENT="prod:<production-deployment>"
bunx convex deploy --typecheck enable --codegen enable \
  --message "activate provider connection indexes"
```

Do not activate an index that is still backfilling. Activation does not cut over
reads.

## 6. Cut over neutral reads

After every staged index is active and parity still passes, make a second,
dedicated source change that replaces Google legacy fallbacks with neutral index
reads. Cut over one bounded query family at a time, run the read-only preflight,
then perform an explicitly confirmed production deploy. Repeat parity and
product smoke tests after each family. If a neutral read regresses, redeploy the
previous read path; keep the additive index and data.

## 7. Drain compatibility targets

New source must emit only `internal.domains.sync.engine.*`, with
`internal.domains.sync.jobs.*` for the shared job entry points.
`calendarSync.ts` is itself a drain-only facade; its removal is coupled to
`googleSync.ts` through `finishLegacySharedFullResync`. Keep `googleSync.ts`
until the Convex scheduler/running-functions views show no
`internal.googleSync.*` target for at least 24 hours, covering a full
engagement-maintenance interval, and logs show no missing-function retries.

The retained scheduled `googleSync.ts` targets are:

- Queued pre-cutover targets: `syncUser`, `recomputeEngagement`, `enqueueSyncs`,
  `enqueueEngagementRefresh`, `backfillPeople`,
  `cleanupRemovedCalendarEvents`
- Short-lived in-flight query targets: `getSyncState`,
  `listCalendarsForUser`, `listEventsPageForEngagement`
- Short-lived in-flight lease/state targets: `ensureSyncState`,
  `claimSyncLease`, `recordSyncOutcome`, `claimSharedCalendarSync`,
  `releaseSharedCalendarLease`, `setSharedCalendarSynced`, `setContactsSync`,
  `setOtherContactsSync`, `setCalendarSyncToken`
- Short-lived in-flight reconciliation targets: `reconcileCalendars`,
  `clearCalendarEventsBatch`, `beginCalendarFullResync`, `upsertEventsPage`,
  `sweepStaleCalendarEventsBatch`, `commitCalendarFullResync`,
  `clearSharedCalendarEventsBatch`, `upsertSharedEventsPage`,
  `beginContactsFullResync`, `upsertContactsPage`,
  `upsertOtherContactsPage`, `sweepStaleContactsBatch`,
  `sweepStaleOtherPeopleBatch`, `applyEngagementScores`

After the drain gate, remove `googleSync.ts`,
`domains/sync/googleCompat.ts`, and the compatibility-only engine definitions in
a dedicated deploy. Restore the exact missing target if logs reveal a late
queued call.

`internal.calendarSync.finishLegacySharedFullResync` is the fenced continuation
that lets an old shared-calendar action finish its generation sweep without
clearing the live snapshot first. Keep it through the same drain gate and until
its own scheduled calls are empty.

`backfillUserEvents` and `backfillUserTail` remain until all
old backfill schedules drain. The root `backfillConnections.ts` is itself a
drain-only facade over `migrations/backfillConnections.ts`, kept while old
backfill schedules and pre-cutover operator commands still use the
`internal.backfillConnections.*` spelling. The `verifyParity.sampleLimit` argument remains
until old operator commands are no longer used. `internal.calendarSync.syncUser`
remains while one-shot migrations still schedule user-scoped refreshes.

`internal.booking.expireBooking` has an active scheduled-jobs migration rather
than a passive drain: `requestBooking` schedules it as far as 365 days out, so
waiting out the queue horizon is not viable. Rehearse on a preview deployment
first: deploy, run `migrations/scheduledJobs:seedLegacyExpireBookingJobs`,
sweep with `migrations/scheduledJobs:listPendingFunctionNames`, run
`migrateExpireBookingSchedules` as a dry run and then for real, verify the
counts moved to `domains/booking/mutations.js:expireBooking` with
`scheduledTime` and args preserved, and re-run to confirm a no-op. In
production, run the migration no earlier than 24 hours after the expand
deploy, sweep before and after, and re-sweep immediately before the
facade-deletion deploy. The 15-minute `expirePastBookings` cron remains the
safety net for any missed entry. After verification, `booking.ts` joins
deletion wave 1 below.

The legacy `internal.calendar.getPrimaryCalendarId`, `deleteEventRow`,
`upsertEvent`, and `upsertRecurringSeries` handlers are in-flight action shims.
New provider-neutral code must not call them. Remove them only after the Convex
running-functions view and logs show no call from a pre-cutover calendar action
for at least 24 hours, and after stored assistant proposals from the old action
shape have either executed or aged out. Restore the exact target if a late call
appears. The old-shape `internal.calendarSync.applyEngagementScores` handler has
the same running-action drain gate; the coordinated engine uses
`applyEngagementScoreChunk` instead.

### Root facade drain

Every root facade file must pass the same observable gate before deletion: a
`migrations/scheduledJobs:listPendingFunctionNames` sweep shows zero pending
old-path names for the file, dashboard function metrics show zero invocations
of the facade's public paths for 7 days after the frontend rollout, and the
running-functions view and logs are clean. What persists references to each:

| Facade | Persisted references |
| --- | --- |
| `booking.ts` | Pre-deploy `expireBooking` scheduler entries up to 365 days out; in-flight acceptance cross-calls (minutes); stale tabs |
| `maintenance.ts` | Self-reschedule chains (hours); operator one-shots |
| `backfillConnections.ts` | Old backfill self-reschedules (drain in minutes once idle); operator commands using the un-prefixed spelling |
| `assistant.ts` | Stale tabs (days) |
| `assistantData.ts` | `releaseStaleAction` lease schedules (minutes); stale tabs |
| `assistantMaintenance.ts` | Stale tabs (days) |
| `notifications.ts` | Stale tabs (days) |
| `people.ts` | Stale tabs (days) |
| `waitlist.ts` | Stale tabs (days) |
| `calendar.ts` | The four legacy `internal.calendar.*` shims, gated on running pre-cutover actions and on stored assistant proposals aging out (~30 days); stale tabs |
| `calendarSync.ts` | Coupled to the `internal.googleSync.*` drain gate above |

Deletion happens in two waves:

1. Wave 1, no earlier than ~7 days after the expand deploy and after the
   verified `expireBooking` schedule migration: `booking.ts`,
   `maintenance.ts`, `backfillConnections.ts`, `assistant.ts`,
   `assistantData.ts`, `assistantMaintenance.ts`, `notifications.ts`,
   `people.ts`, `waitlist.ts`.
2. Wave 2, at least 30 days out, only after the `internal.googleSync.*` gate
   and the assistant-proposal age-out: `calendar.ts`, `calendarSync.ts`,
   `googleSync.ts`, and `domains/sync/googleCompat.ts` together, plus the
   compatibility-only engine definitions and `shared/functionDefinitions.ts`
   if then unused.

For each wave, delete the facade file(s) and their blocks in
`tests/rootFacades.test.ts` in the same commit, run the full read-only
preflight, re-run the sweep, deploy, and watch logs for 24 hours. Restore the
exact missing target if a late call appears. `tests/noLegacyPaths.test.ts`
enforces that no new source emits facade paths.

## 8. Contract storage and wire DTOs

Contract only after all parity phases pass twice, staged indexes are active,
neutral reads and writes have run without fallback in production, every
connection has completed a full sync, compatibility queues are drained, and a
fresh backup/export exists. Perform contract in separate reversible deploys:

1. Stop writing legacy mirrors while retaining readers and schema.
2. Re-run the complete backfill/parity scan and observe one full sync cycle.
3. Remove legacy read fallbacks and old indexes; verify and observe again.
4. Remove legacy fields/tables from the schema only after no deployed code,
   queued function, stored payload, or rollback build references them.
5. Remove the backfill progress table and migration functions last.

Intentionally retained until that sequence completes:

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
- Stored legacy assistant/calendar action DTO normalization, raw and wrapped
  Google cursor decoding, backfill entry-point aliases, and the queue targets
  listed above

At every contract step, unexpected missing-function errors, parity mismatches,
duplicate provider identities, elevated sync/booking failures, or unresolved
neutral ids are rollback gates. Restore code/read compatibility first; never
restore by deleting neutral production data.
