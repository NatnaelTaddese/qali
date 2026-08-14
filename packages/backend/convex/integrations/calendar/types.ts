/**
 * The provider-neutral calendar port.
 *
 * Every calendar integration (Google today, Microsoft next) implements
 * `CalendarProviderAdapter`. The domain layer talks only to this interface, so
 * adding a provider is writing one adapter — never re-touching the services.
 *
 * Design rules that keep it honest:
 *  - No provider-shaped identifiers. Ids are opaque `string`s; a Google event id
 *    and a Graph event id are indistinguishable here.
 *  - Cursors are opaque (see {@link SyncCursor}). Google sync tokens and Graph
 *    delta links stay inside their adapter.
 *  - Idempotency is a capability of the adapter, not an assumption of the caller
 *    (see {@link EventWrite.idempotencyKey} and
 *    {@link CalendarProviderAdapter.reconcileAmbiguousCreate}). The caller mints
 *    a key; the adapter maps it to whatever the provider offers — Google a
 *    client-assigned event id, Microsoft a `transactionId`.
 *  - Times are epoch-millis + an all-day flag, never provider date strings.
 */

import type { ProviderError } from "./errors";

export type ProviderId = "google" | "microsoft";

/** Opaque provider cursor. The string is meaningful only to the adapter that
 * issued it (a Google `syncToken`, a Graph delta link). Callers persist and
 * replay it without inspecting it. */
export type SyncCursor = string;

/** One page of a delta/list sync. `nextPageCursor` walks within a single sync
 * pass; `commitCursor` is the cursor to persist once the whole pass has been
 * durably written, so an interrupted pass never advances the stored cursor. */
export interface SyncPage<T> {
  readonly items: readonly T[];
  readonly nextPageCursor: SyncCursor | null;
  readonly commitCursor: SyncCursor | null;
}

export interface ProviderCalendar {
  readonly id: string;
  readonly summary?: string;
  readonly primary?: boolean;
  readonly timeZone?: string;
  readonly color?: string;
  /** Whether the authenticated user can write events to this calendar. The
   * adapter normalizes each provider's access-role vocabulary into this. */
  readonly writable: boolean;
}

export interface ProviderPerson {
  readonly email?: string;
  readonly displayName?: string;
  /** The provider's authoritative "this is the caller's own copy" marker. */
  readonly self?: boolean;
}

export interface ProviderAttendee extends ProviderPerson {
  readonly responseStatus?: "needsAction" | "accepted" | "tentative" | "declined";
  readonly organizer?: boolean;
  readonly optional?: boolean;
}

export interface ProviderConference {
  readonly url?: string;
  readonly name?: string;
  readonly type?: string;
}

export type EventStatus = "confirmed" | "tentative" | "cancelled";

/** A calendar event as a provider reports it, fully normalized. Field names are
 * provider-neutral: `id` (not googleEventId), `updatedMs` (not googleUpdatedMs),
 * conference folded into one shape. The guest-permission tri-states are kept as
 * normalized optionals because they are a shared calendar concept, not a Google
 * quirk; turning them into capabilities stays a domain concern. */
export interface ProviderEvent {
  readonly id: string;
  readonly calendarId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly allDay: boolean;
  readonly status: EventStatus;
  readonly updatedMs: number;
  readonly htmlLink?: string;
  readonly color?: string;
  readonly visibility?: string;
  /** False when the organizer marked the event as not-busy ("free"). */
  readonly busy?: boolean;
  readonly attendees?: readonly ProviderAttendee[];
  readonly attendeesOmitted?: boolean;
  readonly organizer?: ProviderPerson;
  readonly creator?: ProviderPerson;
  readonly guestsCanModify?: boolean;
  readonly guestsCanInviteOthers?: boolean;
  readonly guestsCanSeeOtherGuests?: boolean;
  readonly locked?: boolean;
  /** Provider event category ("default" | "birthday" | "outOfOffice" | …). */
  readonly eventType?: string;
  /** Set on an expanded instance of a series; ties it back to its master. */
  readonly seriesId?: string;
  readonly conference?: ProviderConference;
}

/** Fields the caller supplies to create or patch an event. Times are neutral
 * epoch-millis; the adapter renders them the way its provider wants. */
export interface EventWrite {
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly allDay?: boolean;
  readonly color?: string;
  readonly visibility?: string;
  readonly busy?: boolean;
  readonly attendees?: readonly {
    readonly email: string;
    readonly displayName?: string;
    readonly optional?: boolean;
  }[];
  /** RFC5545 recurrence lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. */
  readonly recurrence?: readonly string[];
  readonly addConference?: boolean;
  readonly timeZone?: string;
}

/** Whether an invitation reply, delete, etc. should notify the other guests. */
export type NotifyScope = "all" | "none";

/** Who a change or read is authorized against. The adapter is already bound to a
 * provider + credential, so the caller only names the calendar + event. */
export interface EventRef {
  readonly calendarId: string;
  readonly eventId: string;
}

/**
 * A create request. `idempotencyKey` is an app-minted token, stable across
 * retries of the *same* logical create. The adapter maps it to the provider's
 * native dedup mechanism so a retry that actually landed the first time is
 * reconciled, not duplicated. THIS is the seam that keeps ambiguous-create
 * safety provider-neutral (Interface Risk #1): Google maps it to a
 * client-assigned event id, Microsoft to a `transactionId`.
 */
export interface CreateEventRequest {
  readonly calendarId: string;
  readonly event: EventWrite;
  readonly notify?: NotifyScope;
  readonly idempotencyKey?: string;
}

/** What a provider can do beyond the base calendar CRUD, declared so services
 * never assume an optional feature exists. */
export interface ProviderCapabilities {
  /** The provider exposes a contacts/people feed (Google People, Graph
   * contacts). When false, contacts sync is simply skipped for this connection. */
  readonly contacts: boolean;
  /** The provider accepts an app-supplied idempotency token on create. When
   * false, the domain falls back to reconcile-by-search after an ambiguous write. */
  readonly idempotentCreate: boolean;
}

/**
 * The calendar port. An adapter instance is already bound to one provider and
 * one credential (see the credential broker), so no method takes a token.
 *
 * Every method rejects with a {@link ProviderError} on failure, so callers
 * branch on `kind` rather than on a provider's HTTP status.
 */
export interface CalendarProviderAdapter {
  readonly provider: ProviderId;
  readonly capabilities: ProviderCapabilities;

  /** The calendars available to the authenticated user. */
  listCalendars(): Promise<readonly ProviderCalendar[]>;

  /**
   * A page of changes for one calendar. `cursor === null` requests a full
   * resync bounded by [fromMs, toMs]; a non-null cursor requests the delta
   * since it. A stale cursor rejects with a `cursor-expired` ProviderError.
   */
  listEvents(args: {
    readonly calendarId: string;
    readonly cursor: SyncCursor | null;
    readonly fromMs: number;
    readonly toMs: number;
  }): Promise<SyncPage<ProviderEvent>>;

  getEvent(ref: EventRef): Promise<ProviderEvent>;

  createEvent(request: CreateEventRequest): Promise<ProviderEvent>;

  /**
   * Resolve whether a create identified by `idempotencyKey` already exists,
   * after an ambiguous failure. Returns the landed event or `null` if it never
   * did. Provider-specific: Google reads the client-assigned id back, Microsoft
   * queries by `transactionId`.
   */
  reconcileAmbiguousCreate(args: {
    readonly calendarId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderEvent | null>;

  updateEvent(args: {
    readonly ref: EventRef;
    readonly patch: EventWrite;
    readonly notify?: NotifyScope;
  }): Promise<ProviderEvent>;

  /** Answer an invitation. Separate from `updateEvent` because responding is not
   * editing — it works on events locked against every other change. */
  respondToEvent(args: {
    readonly ref: EventRef;
    readonly responseStatus: "accepted" | "tentative" | "declined";
    readonly notify?: NotifyScope;
  }): Promise<ProviderEvent>;

  deleteEvent(args: {
    readonly ref: EventRef;
    readonly notify?: NotifyScope;
  }): Promise<void>;
}

export type { ProviderError };
