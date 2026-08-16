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
connection sync, staged indexes, backfill functions, and all queue-drain shims:

```sh
export CONVEX_DEPLOYMENT="prod:<production-deployment>"
bunx convex deploy --typecheck enable --codegen enable \
  --message "expand provider connections and retain queue-drain shims"
```

Verify the deployment health check, Better Auth login, calendar range reads,
one manual sync, one event write, booking request/acceptance, cron registration,
and function error logs. Roll back application code if behavior regresses, but
do not remove additive fields, indexes, or compatibility targets.

## 3. Backfill

Start exactly one resumable discovery run. Re-running is safe and creates a new
run id, but do not start overlapping runs intentionally.

```sh
bunx convex run backfillConnections:enqueueConnectionBackfill '{}' --prod
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
bunx convex run backfillConnections:verifyParity \
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

New source must emit only `internal.calendarSync.*`. Keep `googleSync.ts` until
the Convex scheduler/running-functions views show no `internal.googleSync.*`
target for at least 24 hours, covering a full engagement-maintenance interval,
and logs show no missing-function retries.

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

`backfillConnections.backfillUserEvents` and `backfillUserTail` remain until all
old backfill schedules drain. The `verifyParity.sampleLimit` argument remains
until old operator commands are no longer used. `internal.calendarSync.syncUser`
remains while one-shot migrations still schedule user-scoped refreshes.

`internal.booking.expireBooking` is not part of this drain. `requestBooking`
schedules it as far as 365 days out and acceptance may schedule it for lease
expiry. It must remain registered until code has stopped scheduling it and the
full maximum queue horizon has elapsed; currently it remains permanent.

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
