# Backend Architecture

## Module boundaries

- Function registration is canonical in the module that owns the logic:
  `convex/domains/<domain>/*`, `convex/jobs/*`, and `convex/migrations/*`. The
  root `convex/*.ts` files are entrypoints only — `schema.ts`, `crons.ts`,
  `http.ts`, `auth.ts`, `auth.config.ts`, `convex.config.ts`, and
  `healthCheck.ts` — and register no domain logic.
- `convex/domains/<domain>/` owns business rules, database handlers, validators,
  and table declarations for that domain. `schema.ts` only composes those tables.
- `convex/domains/sync/engine.ts` owns provider-neutral sync orchestration. All
  calls and schedules use `internal.domains.sync.engine.*`.
- `convex/integrations/calendar/` defines provider ports, capabilities, errors,
  and adapter lookup. Domains depend on these neutral contracts, never on a
  concrete provider client.
- `convex/integrations/google/` implements the calendar and contacts ports. It
  may translate Google wire shapes, but it does not own app tables or public API
  registration.
- `convex/jobs/` owns recurring maintenance implementations;
  `convex/migrations/` owns resumable one-shot data changes (including
  `migrations/backfillConnections.ts` and the scheduler repoint tooling in
  `migrations/scheduledJobs.ts`). Migration code must not become a steady-state
  domain dependency.
- `auth.ts` configures Better Auth and exports server helpers. Better Auth HTTP
  routes are registered by `http.ts`; there is intentionally no public
  `api.auth.*` query.

Dependencies point inward: domain -> neutral integration port. Concrete
provider adapters depend on the port and provider client. Domain modules must
not import root entrypoint files. Cross-function calls use generated `api` or
`internal` references. Canonical registered paths are persisted API: scheduler
entries store path strings, so renaming a `domains/` file or a registered
export strands anything already queued against the old spelling. A rename
therefore carries the same scheduler obligations as a deletion — a repoint
migration for long-horizon schedules (see `migrations/scheduledJobs.ts`), or an
explicitly accepted one-time failure healed by crons and lease recovery.
Public functions authenticate in their handler and internal-only work is
registered with `internalQuery`, `internalMutation`, or `internalAction`.

## Intended API surface

The application-supported public Convex API is:

- `api.domains.assistant.loop`: `confirmAction`, `sendMessage`
- `api.domains.assistant.data`: `isAvailable`, `listMessages`,
  `listPendingActions`, `listThreads`, `monthlyQuota`
- `api.domains.assistant.maintenance`: `deleteThread`
- `api.domains.booking.queries`: `bookingPageDefaults`, `checkSlugAvailable`,
  `getBookingByToken`, `getMyBookingPage`, `getPublicPage`, `listMyBookings`,
  `listMyOverrides`, `listPendingBookings`, `listSlots`
- `api.domains.booking.mutations`: `rejectBooking`, `requestBooking`,
  `setOverride`, `upsertBookingPage`
- `api.domains.booking.service`: `acceptBooking`
- `api.domains.calendar.queries`: `getEventById`, `getEventRecurrence`,
  `listCalendars`, `listEventsInRange`
- `api.domains.calendar.mutations`: `setCalendarSelected`
- `api.domains.calendar.service`: `createEvent`, `deleteEvent`,
  `refreshEventRecurrence`, `respondToEvent`, `updateEvent`, `updateEventTime`
- `api.domains.sync.engine`: `syncNow`
- `api.domains.notifications.queries`: `list`, `unreadCount`
- `api.domains.notifications.mutations`: `clearAll`, `dismiss`, `markAllRead`,
  `markRead`
- `api.domains.people.queries`: `listPeople`
- `api.domains.marketing.mutations`: `join`
- `api.healthCheck`: `get`

`api.domains.calendar.service.createEvent.calendarId`, when supplied, is the
owned local
`Id<"calendars">`. Provider-native calendar ids are resolved only after the
ownership check; omitting it deterministically targets the user's primary.

Better Auth remains exposed only through the HTTP routes registered in
`http.ts`. Internal functions and CLI-only migration functions are not product
API.

## Compatibility policy

Compatibility code needs a concrete production reason: persisted rows, stored
assistant payloads, or an already-scheduled function target. Every retained
piece must name that reason and a removal gate. Low usage alone is not a reason
to keep an unconsumed public API.

There is no path-level compatibility surface. The pre-reorg root facades and
provider-named sync modules are deleted from source; persisted references to
their paths are handled by the hard cutover in `MIGRATION_RUNBOOK.md` — a
one-shot scheduler repoint migration for the long-horizon booking-expiry
entries, and accepted one-time failures, healed by crons and lease recovery,
for everything else.

The legacy data model is the one remaining compatibility surface. It is
scheduled for removal in the data-contraction stage
(`MIGRATION_RUNBOOK.md` section 8), not permanent. Until that stage lands:

- Google-named columns, optional neutral mirrors, legacy tables, and old
  indexes remain in the schema, kept in agreement by dual writes. No schema
  field, table, or index is removed as part of source cleanup.
- Neutral indexes added to pre-existing calendar, event, contact, recurring,
  and booking tables are staged. Runtime reads stay on the complete Google
  legacy indexes until every staged index is ready and a dedicated activation
  deploy has completed; the neutral read cutover belongs to the contraction
  stage.
- Microsoft connections remain unavailable until that cutover, while the
  domain and adapter contracts remain provider-neutral.
