/**
 * Provider-neutral calendar port. Provider identifiers and cursors are opaque;
 * callers persist and replay them without inspecting their contents.
 */

export type ProviderId = "google" | "microsoft";

declare const syncCursorBrand: unique symbol;
declare const pageCursorBrand: unique symbol;

/** A committed cursor used to begin a later delta pass. */
export type SyncCursor = string & { readonly [syncCursorBrand]: true };
/** A continuation used only to fetch the next page of the current pass. */
export type PageCursor = string & { readonly [pageCursorBrand]: true };

/** `commitCursor` is persisted only after every page has been durably applied. */
export interface SyncPage<T> {
  readonly items: readonly T[];
  readonly nextPageCursor: PageCursor | null;
  readonly commitCursor: SyncCursor | null;
}

export interface ProviderCalendar {
  readonly id: string;
  readonly summary?: string;
  readonly primary?: boolean;
  readonly timeZone?: string;
  readonly color?: string;
  readonly writable: boolean;
  readonly selected?: boolean;
  /** Safe to store once for every user. Providers must classify conservatively. */
  readonly shared?: boolean;
}

export interface ProviderPerson {
  readonly email?: string;
  readonly displayName?: string;
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

/**
 * A normalized provider event.
 *
 * Google syncs with recurrence expansion enabled. Consequently `listEvents`
 * returns occurrences, not recurring masters: an occurrence has `seriesId` and
 * `originalOccurrenceStartMs`, while `recurrence` is normally absent. A master
 * returned by `getEvent`, create, or update has `recurrence` and normally no
 * `seriesId`. `originalOccurrenceStartMs` is the occurrence's position before
 * an exception moved it. `timeZone` is the provider's IANA recurrence anchor;
 * all-day events may omit it.
 */
export interface ProviderEvent {
  readonly id: string;
  readonly calendarId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly allDay: boolean;
  readonly timeZone?: string;
  readonly status: EventStatus;
  readonly updatedMs: number;
  readonly htmlLink?: string;
  readonly color?: string;
  readonly visibility?: string;
  readonly busy?: boolean;
  readonly attendees?: readonly ProviderAttendee[];
  /** True means the provider withheld attendees; never use this list as the
   * source of a membership replacement or RSVP write. */
  readonly attendeesOmitted?: boolean;
  readonly organizer?: ProviderPerson;
  readonly creator?: ProviderPerson;
  readonly guestsCanModify?: boolean;
  readonly guestsCanInviteOthers?: boolean;
  readonly guestsCanSeeOtherGuests?: boolean;
  readonly locked?: boolean;
  readonly eventType?: string;
  readonly recurrence?: readonly string[];
  readonly seriesId?: string;
  readonly originalOccurrenceStartMs?: number;
  readonly conference?: ProviderConference;
}

export interface EventAttendeeInput {
  readonly email: string;
  readonly displayName?: string;
  readonly optional?: boolean;
}

/** Fields accepted when creating an event. Create has no clearing semantics. */
export interface EventCreate {
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly allDay?: boolean;
  readonly color?: string;
  readonly visibility?: string;
  readonly busy?: boolean;
  readonly attendees?: readonly EventAttendeeInput[];
  readonly recurrence?: readonly string[];
  readonly conference?: "add";
  readonly timeZone?: string;
}

export type ConferenceChange = "add" | "remove" | "preserve";

/**
 * Fields accepted when patching an event. Omission preserves a field. `null`
 * explicitly clears provider fields that the current domain allows clearing.
 * `attendees`, when present, is the complete desired membership list, not a
 * list of additions; adapters must reject a partial live provider list before
 * replacing membership.
 */
export interface EventPatch {
  readonly summary?: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly allDay?: boolean;
  readonly color?: string | null;
  readonly visibility?: string | null;
  readonly busy?: boolean;
  readonly attendees?: readonly EventAttendeeInput[];
  readonly recurrence?: readonly string[];
  readonly conference?: ConferenceChange;
  readonly timeZone?: string;
}

export type NotifyScope = "all" | "none";

export interface EventRef {
  readonly calendarId: string;
  readonly eventId: string;
}

/** Stable across retries of the same logical create. */
export interface CreateEventRequest {
  readonly calendarId: string;
  readonly event: EventCreate;
  /** Copy provider-complete attendee objects from a live event before applying
   * `event.attendees`. Used when splitting a series without stripping resources,
   * comments, organizer entries, or other provider-only attendee metadata. */
  readonly attendeeSourceRef?: EventRef;
  /** Membership visible when the desired attendee edit was prepared. Attendees
   * present live but absent from this snapshot are concurrent additions and
   * must be preserved rather than treated as requested removals. */
  readonly knownAttendeeEmails?: readonly string[];
  readonly notify?: NotifyScope;
  readonly idempotencyKey?: string;
}

export interface UpdateEventRequest {
  readonly ref: EventRef;
  readonly patch: EventPatch;
  readonly notify?: NotifyScope;
  /** Stable across retries. Enables a semantic read-before-retry no-op. */
  readonly idempotencyKey?: string;
  /** Refuse a conflict-sensitive update if the provider event has changed. */
  readonly expectedUpdatedMs?: number;
  /** Local attendee snapshot used to distinguish removals from concurrent adds. */
  readonly knownAttendeeEmails?: readonly string[];
}

export interface RespondToEventRequest {
  readonly ref: EventRef;
  readonly responseStatus: "accepted" | "tentative" | "declined";
  readonly notify?: NotifyScope;
  readonly idempotencyKey?: string;
}

export type DeleteMode = "cancel" | "remove-self";

export interface DeleteEventRequest {
  readonly ref: EventRef;
  readonly mode: DeleteMode;
  readonly notify?: NotifyScope;
  readonly idempotencyKey?: string;
}

export interface ProviderCapabilities {
  readonly contacts: boolean;
  readonly recurringEvents: boolean;
  readonly attendeeMembershipUpdates: boolean;
  readonly rsvp: boolean;
  readonly removeSelf: boolean;
  readonly conference: {
    readonly create: boolean;
    readonly add: boolean;
    readonly remove: boolean;
  };
  /** Idempotency may be native or implemented by semantic reconciliation. */
  readonly idempotentCreate: boolean;
  readonly idempotentUpdate: boolean;
  readonly idempotentResponse: boolean;
  readonly idempotentDelete: boolean;
}

export interface CalendarProviderAdapter {
  readonly provider: ProviderId;
  readonly capabilities: ProviderCapabilities;

  listCalendars(): Promise<readonly ProviderCalendar[]>;

  /**
   * `syncCursor` anchors the pass (`null` means a bounded full sync), while
   * `pageCursor` continues that same pass. They must never be interchanged.
   */
  listEvents(args: {
    readonly calendarId: string;
    readonly syncCursor: SyncCursor | null;
    readonly pageCursor?: PageCursor | null;
    readonly fromMs: number;
    readonly toMs: number;
  }): Promise<SyncPage<ProviderEvent>>;

  getEvent(ref: EventRef): Promise<ProviderEvent>;
  createEvent(request: CreateEventRequest): Promise<ProviderEvent>;

  reconcileAmbiguousCreate(args: {
    readonly calendarId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderEvent | null>;

  updateEvent(request: UpdateEventRequest): Promise<ProviderEvent>;
  respondToEvent(request: RespondToEventRequest): Promise<ProviderEvent>;
  deleteEvent(request: DeleteEventRequest): Promise<void>;
}
