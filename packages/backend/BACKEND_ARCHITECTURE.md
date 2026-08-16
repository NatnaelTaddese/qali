# Backend Architecture

## Module boundaries

- Root `convex/*.ts` files are registration facades. They validate a callable
  boundary and delegate; they do not own domain logic.
- `convex/domains/<domain>/` owns business rules, database handlers, validators,
  and table declarations for that domain. `schema.ts` only composes those tables.
- `convex/domains/sync/engine.ts` owns provider-neutral sync orchestration. New
  calls and schedules register through `calendarSync.ts` and use
  `internal.calendarSync.*`.
- `convex/integrations/calendar/` defines provider ports, capabilities, errors,
  and adapter lookup. Domains depend on these neutral contracts, never on a
  concrete provider client.
- `convex/integrations/google/` implements the calendar and contacts ports. It
  may translate Google wire shapes, but it does not own app tables or public API
  registration.
- `convex/jobs/` owns recurring maintenance implementations;
  `convex/migrations/` and `backfillConnections.ts` own resumable one-shot data
  changes. Migration code must not become a steady-state domain dependency.
- `convex/domains/sync/googleCompat.ts` temporarily preserves the exact
  pre-cutover `internal.googleSync.*` cross-call contracts for actions already
  running during deployment. Its removal gate is the queue/running-function
  drain in `MIGRATION_RUNBOOK.md`.
- A small set of old `internal.calendar.*` storage callbacks and the old-shape
  `internal.calendarSync.applyEngagementScores` callback remain solely for
  actions already running during cutover. Their explicit removal gates are in
  the runbook; new code uses provider-neutral operation and chunked engagement
  callbacks.
- `auth.ts` configures Better Auth and exports server helpers. Better Auth HTTP
  routes are registered by `http.ts`; there is intentionally no public
  `api.auth.*` query.

Dependencies point inward: registration facade -> domain -> neutral integration
port. Concrete provider adapters depend on the port and provider client. Domain
modules must not import root registration facades; cross-function calls use
generated `api` or `internal` references. Public functions authenticate in their
handler and internal-only work is registered with `internalQuery`,
`internalMutation`, or `internalAction`.

## Intended API surface

The application-supported public Convex API is:

- `api.assistant`: `confirmAction`, `sendMessage`
- `api.assistantData`: `isAvailable`, `listMessages`, `listPendingActions`,
  `listThreads`, `monthlyQuota`
- `api.assistantMaintenance`: `deleteThread`
- `api.booking`: `acceptBooking`, `bookingPageDefaults`, `checkSlugAvailable`,
  `getBookingByToken`, `getMyBookingPage`, `getPublicPage`, `listMyBookings`,
  `listMyOverrides`, `listPendingBookings`, `listSlots`, `rejectBooking`,
  `requestBooking`, `setOverride`, `upsertBookingPage`
- `api.calendar`: `createEvent`, `deleteEvent`, `getEventById`,
  `getEventRecurrence`, `listCalendars`, `listEventsInRange`,
  `refreshEventRecurrence`, `respondToEvent`, `setCalendarSelected`,
  `updateEvent`, `updateEventTime`
- `api.calendarSync`: `syncNow`
- `api.healthCheck`: `get`
- `api.notifications`: `clearAll`, `dismiss`, `list`, `markAllRead`, `markRead`,
  `unreadCount`
- `api.people`: `listPeople`
- `api.waitlist`: `join`

`api.calendar.createEvent.calendarId`, when supplied, is the owned local
`Id<"calendars">`. Provider-native calendar ids are resolved only after the
ownership check; omitting it deterministically targets the user's primary.

Better Auth remains exposed only through the HTTP routes registered in
`http.ts`. Internal functions and CLI-only migration functions are not product
API. In particular, `googleSync.ts` is a temporary internal queue-drain module,
not a public provider API.

## Compatibility policy

Compatibility code needs a concrete production reason: persisted rows, stored
assistant payloads, or an already-scheduled/running function target. Every shim
must name that reason and a removal gate. Low usage alone is not a reason to keep
an unconsumed public API.

The connection migration is still expanded, not contracted. Google-named
columns, optional neutral mirrors, legacy tables, and old indexes remain until
the production backfill and neutral-read verification in
`MIGRATION_RUNBOOK.md` complete. No schema field, table, or index is removed as
part of source cleanup.

All neutral indexes added to pre-existing calendar, event, contact, recurring,
and booking tables are staged for the initial deploy. Runtime reads stay on the
complete Google legacy indexes until every staged index is ready and a dedicated
activation deploy has completed; neutral read cutover is a later, separate
deploy. Microsoft connections remain unavailable until that cutover, while the
domain and adapter contracts remain provider-neutral.
