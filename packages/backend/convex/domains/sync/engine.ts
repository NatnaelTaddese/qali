import { v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  ensureConnectionSyncState,
  ensureGoogleConnection,
} from "../calendar/connections";
import { providerEventValidator } from "../calendar/validators";
import type { ProviderContact } from "../../integrations/calendar/contacts";
import { ProviderError } from "../../integrations/calendar/errors";
import {
  getCalendarAdapter,
  getContactsAdapter,
} from "../../integrations/calendar/registry";
import type {
  CalendarProviderAdapter,
  PageCursor,
  ProviderCalendar,
  ProviderEvent,
  ProviderId,
  SyncCursor,
} from "../../integrations/calendar/types";
import {
  defineAction,
  defineMutation,
  defineQuery,
} from "../../shared/functionDefinitions";

const DAY_MS = 24 * 60 * 60 * 1000;
export const CALENDAR_HISTORY_MS = 180 * DAY_MS;
export const CALENDAR_FUTURE_MS = 365 * DAY_MS;
const SYNC_MIN_MS = 15 * 60 * 1000;
const SYNC_MAX_MS = 60 * 60 * 1000;
const SYNC_LEASE_MS = 10 * 60 * 1000;
const SHARED_LEASE_MS = 5 * 60 * 1000;
const SHARED_REFRESH_MS = DAY_MS;
const BATCH_SIZE = 100;
const FANOUT_BATCH = 100;
const ENGAGEMENT_CHUNK_SIZE = 200;
const ENGAGEMENT_LEASE_MS = 10 * 60 * 1000;

const providerValidator = v.union(v.literal("google"), v.literal("microsoft"));
const providerCalendarValidator = v.object({
  id: v.string(),
  summary: v.optional(v.string()),
  primary: v.optional(v.boolean()),
  timeZone: v.optional(v.string()),
  color: v.optional(v.string()),
  writable: v.boolean(),
  selected: v.optional(v.boolean()),
  shared: v.optional(v.boolean()),
});
const providerContactValidator = v.object({
  id: v.string(),
  deleted: v.boolean(),
  displayName: v.optional(v.string()),
  emails: v.array(v.string()),
  phones: v.array(v.string()),
  photoUrl: v.optional(v.string()),
  version: v.optional(v.string()),
});

class StaleSyncAttemptError extends Error {
  constructor() {
    super("The sync lease is no longer held by this attempt");
  }
}

async function liveState(
  ctx: MutationCtx,
  connectionId: Id<"calendarConnections">,
  attemptId: string,
): Promise<Doc<"connectionSyncState"> | null> {
  const state = await ctx.db
    .query("connectionSyncState")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .unique();
  return state?.syncAttemptId === attemptId &&
    (state.syncLeaseExpiresAt ?? 0) > Date.now()
    ? state
    : null;
}

async function requireLiveState(
  ctx: MutationCtx,
  connectionId: Id<"calendarConnections">,
  attemptId: string,
): Promise<Doc<"connectionSyncState">> {
  const state = await liveState(ctx, connectionId, attemptId);
  if (!state) throw new StaleSyncAttemptError();
  return state;
}

async function mirrorLegacySyncState(
  ctx: MutationCtx,
  userId: string,
  patch: Partial<Omit<Doc<"syncState">, "_id" | "_creationTime" | "userId">>,
): Promise<void> {
  const row = await ctx.db
    .query("syncState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (row) await ctx.db.patch(row._id, patch);
}

function valueEvent(event: ProviderEvent) {
  return {
    ...event,
    attendees: event.attendees?.map((row) => ({ ...row })),
    organizer: event.organizer ? { ...event.organizer } : undefined,
    creator: event.creator ? { ...event.creator } : undefined,
    recurrence: event.recurrence ? [...event.recurrence] : undefined,
    conference: event.conference ? { ...event.conference } : undefined,
  };
}

function storedEvent(
  userId: string,
  connectionId: Id<"calendarConnections">,
  localCalendarId: Id<"calendars">,
  event: ProviderEvent,
  generation?: number,
) {
  const attendees = event.attendees
    ?.filter((row): row is typeof row & { email: string } => Boolean(row.email))
    .map((row) => ({ ...row, email: row.email }));
  return {
    userId,
    googleEventId: event.id,
    calendarId: event.calendarId,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startMs: event.startMs,
    endMs: event.endMs,
    allDay: event.allDay,
    status: event.status,
    htmlLink: event.htmlLink,
    colorId: event.color,
    visibility: event.visibility,
    transparency:
      event.busy === undefined ? undefined : event.busy ? "opaque" : "transparent",
    attendees,
    attendeesOmitted: event.attendeesOmitted,
    googleUpdatedMs: event.updatedMs,
    organizer: event.organizer,
    creator: event.creator,
    guestsCanModify: event.guestsCanModify,
    guestsCanInviteOthers: event.guestsCanInviteOthers,
    guestsCanSeeOtherGuests: event.guestsCanSeeOtherGuests,
    locked: event.locked,
    eventType: event.eventType,
    recurringEventId: event.seriesId,
    hangoutLink:
      event.conference?.type === "hangoutsMeet" ? event.conference.url : undefined,
    conferenceUrl: event.conference?.url,
    conferenceName: event.conference?.name,
    conferenceType: event.conference?.type,
    syncGeneration: generation,
    connectionId,
    localCalendarId,
    providerEventId: event.id,
    providerUpdatedMs: event.updatedMs,
    providerSeriesId: event.seriesId,
    color: event.color,
    busy: event.busy,
  };
}

type PersonInput = { email: string; displayName?: string; photoUrl?: string };
type PersonSource = "connection" | "other" | "attendee";

function eventPeople(event: ProviderEvent): PersonInput[] {
  const people: PersonInput[] = [];
  for (const row of event.attendees ?? []) {
    if (row.email && !row.self) {
      people.push({ email: row.email, displayName: row.displayName });
    }
  }
  for (const row of [event.organizer, event.creator]) {
    if (row?.email && !row.self) {
      people.push({ email: row.email, displayName: row.displayName });
    }
  }
  return people;
}

async function upsertPeople(
  ctx: MutationCtx,
  userId: string,
  source: PersonSource,
  rows: PersonInput[],
): Promise<void> {
  const merged = new Map<string, PersonInput>();
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!email) continue;
    const previous = merged.get(email);
    merged.set(email, {
      email,
      displayName: row.displayName ?? previous?.displayName,
      photoUrl: row.photoUrl ?? previous?.photoUrl,
    });
  }
  const authoritative = source !== "attendee";
  for (const row of merged.values()) {
    const existing = await ctx.db
      .query("people")
      .withIndex("by_user_and_email", (q) =>
        q.eq("userId", userId).eq("email", row.email),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: authoritative
          ? (row.displayName ?? existing.displayName)
          : (existing.displayName ?? row.displayName),
        photoUrl: authoritative
          ? (row.photoUrl ?? existing.photoUrl)
          : existing.photoUrl,
        sources: existing.sources.includes(source)
          ? existing.sources
          : [...existing.sources, source],
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("people", {
        userId,
        email: row.email,
        displayName: row.displayName,
        photoUrl: row.photoUrl,
        sources: [source],
        updatedAt: Date.now(),
      });
    }
  }
}

async function claimPersonSource(
  ctx: MutationCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
  source: "connection" | "other",
  providerContactId: string,
  emailValue: string,
  generation?: number,
): Promise<void> {
  const email = emailValue.trim().toLowerCase();
  if (!email) return;
  const candidates = await ctx.db
    .query("personSourceClaims")
    .withIndex("by_connection_and_source_and_email", (q) =>
      q.eq("connectionId", connectionId).eq("source", source).eq("email", email),
    )
    .collect();
  const existing =
    candidates.find((row) => row.providerContactId === providerContactId) ??
    candidates.find((row) => row.providerContactId === undefined);
  if (existing) {
    await ctx.db.patch(existing._id, {
      providerContactId,
      syncGeneration: generation ?? existing.syncGeneration,
      updatedAt: Date.now(),
    });
  } else {
    await ctx.db.insert("personSourceClaims", {
      userId,
      connectionId,
      source,
      providerContactId,
      email,
      syncGeneration: generation,
      updatedAt: Date.now(),
    });
  }
}

async function releasePersonSource(
  ctx: MutationCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
  source: "connection" | "other",
  providerContactId: string,
  emailValue: string,
): Promise<void> {
  const email = emailValue.trim().toLowerCase();
  if (!email) return;
  const claims = await ctx.db
    .query("personSourceClaims")
    .withIndex("by_connection_and_source_and_email", (q) =>
      q.eq("connectionId", connectionId).eq("source", source).eq("email", email),
    )
    .collect();
  const claim =
    claims.find((row) => row.providerContactId === providerContactId) ??
    claims.find((row) => row.providerContactId === undefined);
  if (claim) await ctx.db.delete(claim._id);
  const remaining = await ctx.db
    .query("personSourceClaims")
    .withIndex("by_user_and_email_and_source", (q) =>
      q.eq("userId", userId).eq("email", email).eq("source", source),
    )
    .first();
  if (remaining) return;
  const person = await ctx.db
    .query("people")
    .withIndex("by_user_and_email", (q) =>
      q.eq("userId", userId).eq("email", email),
    )
    .unique();
  if (!person || !person.sources.includes(source)) return;
  const sources = person.sources.filter((item) => item !== source);
  if (sources.length === 0) await ctx.db.delete(person._id);
  else await ctx.db.patch(person._id, { sources, updatedAt: Date.now() });
}

async function heartbeat(
  ctx: ActionCtx,
  connectionId: Id<"calendarConnections">,
  attemptId: string,
): Promise<void> {
  const extended: boolean = await ctx.runMutation(
    internal.calendarSync.heartbeatSyncLease,
    { connectionId, attemptId },
  );
  if (!extended) throw new StaleSyncAttemptError();
}

export async function syncOneConnectionCalendar(
  ctx: ActionCtx,
  adapter: CalendarProviderAdapter,
  args: {
    connectionId: Id<"calendarConnections">;
    attemptId: string;
    localCalendarId: Id<"calendars">;
    providerCalendarId: string;
    syncCursor?: string;
  },
  forceFull = false,
): Promise<boolean> {
  let cursor = forceFull ? undefined : args.syncCursor;
  let full = !cursor;
  let changed = false;
  for (let retry = 0; retry < 2; retry++) {
    try {
      const generation: number | null = full
        ? await ctx.runMutation(internal.calendarSync.beginCalendarFullResync, {
            connectionId: args.connectionId,
            attemptId: args.attemptId,
            localCalendarId: args.localCalendarId,
          })
        : null;
      if (full && generation === null) throw new StaleSyncAttemptError();
      let pageCursor: PageCursor | null = null;
      let commitCursor: SyncCursor | null = null;
      do {
        await heartbeat(ctx, args.connectionId, args.attemptId);
        const page = await adapter.listEvents({
          calendarId: args.providerCalendarId,
          syncCursor: full ? null : (cursor as SyncCursor),
          pageCursor,
          fromMs: Date.now() - CALENDAR_HISTORY_MS,
          toMs: Date.now() + CALENDAR_FUTURE_MS,
        });
        if (page.items.length > 0) {
          const wrote: boolean = await ctx.runMutation(
            internal.calendarSync.upsertEventsPage,
            {
              connectionId: args.connectionId,
              attemptId: args.attemptId,
              localCalendarId: args.localCalendarId,
              events: page.items.map(valueEvent),
              syncGeneration: generation ?? undefined,
            },
          );
          if (!wrote) throw new StaleSyncAttemptError();
          changed = true;
        }
        pageCursor = page.nextPageCursor;
        commitCursor = page.commitCursor ?? commitCursor;
      } while (pageCursor);

      if (full && generation !== null) {
        let sweepCursor: string | null = null;
        let done = false;
        while (!done) {
          await heartbeat(ctx, args.connectionId, args.attemptId);
          const result: { cursor: string | null; done: boolean; deleted: number } =
            await ctx.runMutation(
              internal.calendarSync.sweepStaleCalendarEventsBatch,
              {
                connectionId: args.connectionId,
                attemptId: args.attemptId,
                localCalendarId: args.localCalendarId,
                keepGeneration: generation,
                cursor: sweepCursor,
              },
            );
          sweepCursor = result.cursor;
          done = result.done;
          changed = changed || result.deleted > 0;
        }
        const committed: boolean = await ctx.runMutation(
          internal.calendarSync.commitCalendarFullResync,
          {
            connectionId: args.connectionId,
            attemptId: args.attemptId,
            localCalendarId: args.localCalendarId,
            syncGeneration: generation,
            syncCursor: commitCursor ?? undefined,
          },
        );
        if (!committed) throw new StaleSyncAttemptError();
      } else if (commitCursor) {
        const committed: boolean = await ctx.runMutation(
          internal.calendarSync.setCalendarSyncCursor,
          {
            connectionId: args.connectionId,
            attemptId: args.attemptId,
            localCalendarId: args.localCalendarId,
            syncCursor: commitCursor,
          },
        );
        if (!committed) throw new StaleSyncAttemptError();
      }
      return changed;
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.kind === "cursor-expired" &&
        retry === 0
      ) {
        cursor = undefined;
        full = true;
        continue;
      }
      throw error;
    }
  }
  return changed;
}

export async function syncSharedCalendar(
  ctx: ActionCtx,
  adapter: CalendarProviderAdapter,
  provider: ProviderId,
  providerCalendarId: string,
): Promise<void> {
  const claim: {
    attemptId: string | null;
    syncCursor?: string;
  } = await ctx.runMutation(internal.calendarSync.claimSharedCalendarSync, {
    provider,
    providerCalendarId,
    refreshIntervalMs: SHARED_REFRESH_MS,
  });
  if (!claim.attemptId) return;
  let cursor = claim.syncCursor;
  let full = !cursor;
  try {
    for (let retry = 0; retry < 2; retry++) {
      try {
        const generation: number | null = full
          ? await ctx.runMutation(internal.calendarSync.beginSharedFullResync, {
              provider,
              providerCalendarId,
              attemptId: claim.attemptId,
            })
          : null;
        if (full && generation === null) throw new StaleSyncAttemptError();
        let pageCursor: PageCursor | null = null;
        let commitCursor: SyncCursor | null = null;
        do {
          const extended: boolean = await ctx.runMutation(
            internal.calendarSync.heartbeatSharedCalendarLease,
            { provider, providerCalendarId, attemptId: claim.attemptId },
          );
          if (!extended) throw new StaleSyncAttemptError();
          const page = await adapter.listEvents({
            calendarId: providerCalendarId,
            syncCursor: full ? null : (cursor as SyncCursor),
            pageCursor,
            fromMs: Date.now() - CALENDAR_HISTORY_MS,
            toMs: Date.now() + CALENDAR_FUTURE_MS,
          });
          if (page.items.length) {
            const wrote: boolean = await ctx.runMutation(
              internal.calendarSync.upsertSharedEventsPage,
              {
                provider,
                providerCalendarId,
                attemptId: claim.attemptId,
                events: page.items.map(valueEvent),
                syncGeneration: generation ?? undefined,
              },
            );
            if (!wrote) throw new StaleSyncAttemptError();
          }
          pageCursor = page.nextPageCursor;
          commitCursor = page.commitCursor ?? commitCursor;
        } while (pageCursor);
        if (full && generation !== null) {
          let sweepCursor: string | null = null;
          let done = false;
          while (!done) {
            const extended: boolean = await ctx.runMutation(
              internal.calendarSync.heartbeatSharedCalendarLease,
              { provider, providerCalendarId, attemptId: claim.attemptId },
            );
            if (!extended) throw new StaleSyncAttemptError();
            const result: { cursor: string | null; done: boolean } =
              await ctx.runMutation(
                internal.calendarSync.sweepStaleSharedEventsBatch,
                {
                  provider,
                  providerCalendarId,
                  attemptId: claim.attemptId,
                  keepGeneration: generation,
                  cursor: sweepCursor,
                },
              );
            sweepCursor = result.cursor;
            done = result.done;
          }
        }
        const committed: boolean = await ctx.runMutation(
          internal.calendarSync.commitSharedCalendarSync,
          {
            provider,
            providerCalendarId,
            attemptId: claim.attemptId,
            syncCursor: commitCursor ?? undefined,
            syncGeneration: generation ?? undefined,
          },
        );
        if (!committed) throw new StaleSyncAttemptError();
        return;
      } catch (error) {
        if (
          error instanceof ProviderError &&
          error.kind === "cursor-expired" &&
          retry === 0
        ) {
          cursor = undefined;
          full = true;
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    console.error(
      `Shared ${provider} calendar sync failed for ${providerCalendarId}:`,
      error instanceof Error ? error.message : error,
    );
    await ctx.runMutation(internal.calendarSync.releaseSharedCalendarLease, {
      provider,
      providerCalendarId,
      attemptId: claim.attemptId,
    });
  }
}

async function syncCalendars(
  ctx: ActionCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
  attemptId: string,
  adapter: CalendarProviderAdapter,
  forceFull: boolean,
): Promise<boolean> {
  await heartbeat(ctx, connectionId, attemptId);
  const listed = await adapter.listCalendars();
  const calendars: {
    localCalendarId: Id<"calendars">;
    providerCalendarId: string;
    syncCursor?: string;
    shared: boolean;
  }[] = await ctx.runMutation(internal.calendarSync.reconcileCalendars, {
    connectionId,
    attemptId,
    calendars: listed.map((row) => ({ ...row })),
  });
  let changed = false;
  for (const calendar of calendars) {
    if (calendar.shared) {
      await syncSharedCalendar(
        ctx,
        adapter,
        adapter.provider,
        calendar.providerCalendarId,
      );
      continue;
    }
    changed =
      (await syncOneConnectionCalendar(
        ctx,
        adapter,
        { connectionId, attemptId, ...calendar },
        forceFull,
      )) || changed;
  }
  return changed;
}

async function syncContactFeed(
  ctx: ActionCtx,
  connectionId: Id<"calendarConnections">,
  attemptId: string,
  feed: "contacts" | "other",
): Promise<boolean> {
  const state: Doc<"connectionSyncState"> | null = await ctx.runQuery(
    internal.calendarSync.getConnectionSyncState,
    { connectionId },
  );
  if (!state) throw new StaleSyncAttemptError();
  const adapter = await getContactsAdapter(ctx, connectionId);
  if (!adapter) return false;
  let cursor = feed === "contacts" ? state.contactsCursor : state.otherContactsCursor;
  let full = !cursor;
  for (let retry = 0; retry < 2; retry++) {
    try {
      const generation: number | null = full
        ? await ctx.runMutation(internal.calendarSync.beginContactsFullResync, {
            connectionId,
            attemptId,
            feed,
          })
        : null;
      if (full && generation === null) throw new StaleSyncAttemptError();
      let pageCursor: PageCursor | null = null;
      let commitCursor: SyncCursor | null = null;
      let changed = false;
      do {
        await heartbeat(ctx, connectionId, attemptId);
        const page = await adapter.listContacts({
          feed,
          syncCursor: full ? null : (cursor as SyncCursor),
          pageCursor,
        });
        if (page.items.length) {
          const wrote: boolean = await ctx.runMutation(
            internal.calendarSync.upsertContactsPage,
            {
              connectionId,
              attemptId,
              feed,
              contacts: page.items.map((row) => ({
                ...row,
                emails: [...row.emails],
                phones: [...row.phones],
              })),
              syncGeneration: generation ?? undefined,
            },
          );
          if (!wrote) throw new StaleSyncAttemptError();
          changed = true;
        }
        pageCursor = page.nextPageCursor;
        commitCursor = page.commitCursor ?? commitCursor;
      } while (pageCursor);
      if (full && generation !== null) {
        let sweepCursor: string | null = null;
        let done = false;
        while (!done) {
          await heartbeat(ctx, connectionId, attemptId);
          const result: { cursor: string | null; done: boolean; deleted: number } =
            await ctx.runMutation(internal.calendarSync.sweepStaleContactsBatch, {
              connectionId,
              attemptId,
              feed,
              keepGeneration: generation,
              cursor: sweepCursor,
            });
          sweepCursor = result.cursor;
          done = result.done;
          changed = changed || result.deleted > 0;
        }
        if (feed === "other") {
          let peopleCursor: string | null = null;
          let peopleDone = false;
          while (!peopleDone) {
            await heartbeat(ctx, connectionId, attemptId);
            const result: {
              cursor: string | null;
              done: boolean;
              deleted: number;
            } = await ctx.runMutation(
              internal.calendarSync.sweepLegacyOtherPeopleBatch,
              {
                connectionId,
                attemptId,
                cursor: peopleCursor,
              },
            );
            peopleCursor = result.cursor;
            peopleDone = result.done;
            changed = changed || result.deleted > 0;
          }
        }
      }
      const committed: boolean = await ctx.runMutation(
        internal.calendarSync.commitContactsSync,
        {
          connectionId,
          attemptId,
          feed,
          syncCursor: commitCursor ?? undefined,
          syncGeneration: generation ?? undefined,
        },
      );
      if (!committed) throw new StaleSyncAttemptError();
      return changed;
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.kind === "cursor-expired" &&
        retry === 0
      ) {
        cursor = undefined;
        full = true;
        continue;
      }
      throw error;
    }
  }
  return false;
}

async function runConnection(
  ctx: ActionCtx,
  connectionId: Id<"calendarConnections">,
  initiatedByUser: boolean,
  forceFull = false,
): Promise<{ changed: boolean; skipped: boolean }> {
  const attemptId: string | null = await ctx.runMutation(
    internal.calendarSync.claimSyncLease,
    { connectionId },
  );
  if (!attemptId) return { changed: false, skipped: true };
  const state: Doc<"connectionSyncState"> | null = await ctx.runQuery(
    internal.calendarSync.getConnectionSyncState,
    { connectionId },
  );
  if (!state) return { changed: false, skipped: true };
  try {
    const adapter = await getCalendarAdapter(ctx, connectionId);
    const eventsChanged = await syncCalendars(
      ctx,
      state.userId,
      connectionId,
      attemptId,
      adapter,
      forceFull,
    );
    const savedContactsChanged = await syncContactFeed(
      ctx,
      connectionId,
      attemptId,
      "contacts",
    );
    const otherContactsChanged = await syncContactFeed(
      ctx,
      connectionId,
      attemptId,
      "other",
    );
    const contactsChanged = savedContactsChanged || otherContactsChanged;
    const changed = eventsChanged || contactsChanged;
    if (eventsChanged) {
      await ctx.runMutation(internal.calendarSync.markEngagementDirty, {
        userId: state.userId,
      });
    }
    await ctx.runMutation(internal.calendarSync.recordSyncOutcome, {
      connectionId,
      attemptId,
      status: "idle",
      active: initiatedByUser || changed,
    });
    return { changed, skipped: false };
  } catch (error) {
    await ctx.runMutation(internal.calendarSync.recordSyncOutcome, {
      connectionId,
      attemptId,
      status: "error",
      active: false,
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export type UserSyncStatus = {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  changed: number;
};

export function summarizeConnectionSyncs(
  results: PromiseSettledResult<{ changed: boolean; skipped: boolean }>[],
): UserSyncStatus {
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<{
      changed: boolean;
      skipped: boolean;
    }> => result.status === "fulfilled",
  );
  const status = {
    total: results.length,
    succeeded: fulfilled.filter((result) => !result.value.skipped).length,
    failed: failures.length,
    skipped: fulfilled.filter((result) => result.value.skipped).length,
    changed: fulfilled.filter((result) => result.value.changed).length,
  };
  if (results.length > 0 && failures.length === results.length) {
    const errors = failures.map((result) =>
      result.reason instanceof Error
        ? result.reason
        : new Error(String(result.reason)),
    );
    throw new AggregateError(
      errors,
      `All ${results.length} calendar connections failed to sync: ${errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  return status;
}

async function runUser(
  ctx: ActionCtx,
  userId: string,
  initiatedByUser: boolean,
  forceFull = false,
): Promise<UserSyncStatus> {
  await ctx.runMutation(internal.calendarSync.ensureSyncState, { userId });
  const connections: Doc<"calendarConnections">[] = await ctx.runQuery(
    internal.calendarSync.listActiveConnections,
    { userId },
  );
  const results = await Promise.allSettled(
    connections.map((connection) =>
      runConnection(ctx, connection._id, initiatedByUser, forceFull),
    ),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        "Calendar connection sync failed:",
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
    }
  }
  const status = summarizeConnectionSyncs(results);
  if (status.failed > 0) {
    console.warn(
      `Calendar sync partially succeeded: ${status.succeeded} succeeded, ${status.failed} failed, ${status.skipped} skipped`,
    );
  }
  return status;
}

export async function syncNowForCurrentUser(
  ctx: ActionCtx,
): Promise<UserSyncStatus> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("Not authenticated");
  return await runUser(ctx, user._id, true);
}

export const syncNow = defineAction({
  args: {},
  handler: (ctx): Promise<UserSyncStatus> => syncNowForCurrentUser(ctx),
});

/** Compatibility action for old user-scoped queued calls. */
export const syncUser = defineAction({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    await runUser(ctx, args.userId, false);
    return null;
  },
});

export const syncConnection = defineAction({
  args: { connectionId: v.id("calendarConnections") },
  handler: async (ctx, args): Promise<null> => {
    try {
      await runConnection(ctx, args.connectionId, false);
    } catch (error) {
      console.error(
        "Scheduled calendar connection sync failed:",
        error instanceof Error ? error.message : error,
      );
    }
    return null;
  },
});

export const forceFullResync = defineAction({
  args: { userId: v.string() },
  handler: (ctx, args): Promise<UserSyncStatus> =>
    runUser(ctx, args.userId, true, true),
});

export const listActiveConnections = defineQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) =>
    (await ctx.db
      .query("calendarConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect()).filter((row) => row.status === "active"),
});

export const getConnectionSyncState = defineQuery({
  args: { connectionId: v.id("calendarConnections") },
  handler: async (ctx, args) =>
    await ctx.db
      .query("connectionSyncState")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .unique(),
});

export const getSyncState = defineQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique(),
});

export const ensureSyncState = defineMutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const legacy = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!legacy) {
      await ctx.db.insert("syncState", {
        userId: args.userId,
        status: "idle",
        nextSyncDueAt: 0,
        syncIntervalMs: SYNC_MIN_MS,
      });
    }
    const userState = await ctx.db
      .query("userSyncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!userState) {
      await ctx.db.insert("userSyncState", {
        userId: args.userId,
        engagementDirty: false,
        engagementGeneration: 0,
        updatedAt: Date.now(),
      });
    }
    const existingConnections = await ctx.db
      .query("calendarConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    if (existingConnections.length === 0) {
      await ensureGoogleConnection(ctx, args.userId);
    } else {
      for (const connection of existingConnections) {
        await ensureConnectionSyncState(ctx, args.userId, connection._id);
      }
    }
    return null;
  },
});

export const claimSyncLease = defineMutation({
  args: { connectionId: v.id("calendarConnections") },
  handler: async (ctx, args): Promise<string | null> => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.status !== "active") return null;
    const state = await ctx.db
      .query("connectionSyncState")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .unique();
    if (!state) return null;
    const now = Date.now();
    if (state.syncAttemptId && (state.syncLeaseExpiresAt ?? 0) > now) return null;
    const attemptId = crypto.randomUUID();
    const patch = {
      status: "syncing" as const,
      syncAttemptId: attemptId,
      syncLeaseExpiresAt: now + SYNC_LEASE_MS,
    };
    await ctx.db.patch(state._id, patch);
    await mirrorLegacySyncState(ctx, state.userId, patch);
    return attemptId;
  },
});

export const heartbeatSyncLease = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const state = await liveState(ctx, args.connectionId, args.attemptId);
    if (!state) return false;
    await ctx.db.patch(state._id, {
      syncLeaseExpiresAt: Date.now() + SYNC_LEASE_MS,
    });
    return true;
  },
});

export const recordSyncOutcome = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    status: v.union(v.literal("idle"), v.literal("error")),
    active: v.boolean(),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const state = await liveState(ctx, args.connectionId, args.attemptId);
    if (!state) return null;
    const interval = args.active
      ? SYNC_MIN_MS
      : Math.min((state.syncIntervalMs ?? SYNC_MIN_MS) * 2, SYNC_MAX_MS);
    const patch = {
      status: args.status,
      lastError: args.status === "error" ? args.lastError : undefined,
      syncIntervalMs: interval,
      nextSyncDueAt: Date.now() + interval,
      syncAttemptId: undefined,
      syncLeaseExpiresAt: undefined,
    };
    await ctx.db.patch(state._id, patch);
    await mirrorLegacySyncState(ctx, state.userId, patch);
    return null;
  },
});

export const enqueueSyncs = defineMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const page = await ctx.db
      .query("connectionSyncState")
      .withIndex("by_nextSyncDueAt", (q) => q.lte("nextSyncDueAt", now))
      .paginate({ cursor: args.cursor ?? null, numItems: FANOUT_BATCH });
    for (const state of page.page) {
      const connection = await ctx.db.get(state.connectionId);
      if (!connection || connection.status !== "active") continue;
      await ctx.scheduler.runAfter(0, internal.calendarSync.syncConnection, {
        connectionId: state.connectionId,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.calendarSync.enqueueSyncs, {
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

export const listCalendarsForUser = defineQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect(),
});

export const reconcileCalendars = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    calendars: v.array(providerCalendarValidator),
  },
  handler: async (ctx, args) => {
    const state = await requireLiveState(ctx, args.connectionId, args.attemptId);
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.userId !== state.userId) {
      throw new StaleSyncAttemptError();
    }
    // Neutral indexes on pre-existing tables are staged for the initial deploy.
    // Google is the only available provider, so the complete legacy user range
    // remains authoritative until the explicit index/read cutover.
    const legacy = (await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", state.userId))
      .collect()).filter(
      (row) =>
        row.connectionId === undefined || row.connectionId === args.connectionId,
    );
    const existing = legacy;
    const byId = new Map<string, Doc<"calendars">>();
    for (const row of legacy) {
      byId.set(row.providerCalendarId ?? row.googleCalendarId, row);
    }
    const seen = new Set(args.calendars.map((row) => row.id));
    const stored: {
      localCalendarId: Id<"calendars">;
      providerCalendarId: string;
      syncCursor?: string;
      shared: boolean;
    }[] = [];
    let primary: Id<"calendars"> | undefined;
    for (const calendar of args.calendars) {
      const current = byId.get(calendar.id);
      const patch = {
        summary: calendar.summary,
        summaryOverride: undefined,
        backgroundColor: calendar.color,
        primary: calendar.primary,
        accessRole: calendar.writable ? "writer" : "reader",
        timeZone: calendar.timeZone,
        googleSelected: calendar.selected,
        connectionId: args.connectionId,
        providerCalendarId: calendar.id,
        isShared: calendar.shared ?? false,
      };
      let id: Id<"calendars">;
      if (current) {
        await ctx.db.patch(current._id, patch);
        id = current._id;
      } else {
        id = await ctx.db.insert("calendars", {
          userId: state.userId,
          googleCalendarId: calendar.id,
          selected: calendar.selected ?? false,
          ...patch,
        });
      }
      if (calendar.primary) primary = id;
      stored.push({
        localCalendarId: id,
        providerCalendarId: calendar.id,
        syncCursor: current?.syncCursor ?? current?.syncToken,
        shared: calendar.shared ?? false,
      });
    }
    for (const calendar of existing) {
      if (seen.has(calendar.providerCalendarId ?? calendar.googleCalendarId)) continue;
      await ctx.db.delete(calendar._id);
      await ctx.scheduler.runAfter(
        0,
        internal.calendarSync.cleanupRemovedCalendarEvents,
        {
          connectionId: args.connectionId,
          localCalendarId: calendar._id,
          providerCalendarId:
            calendar.providerCalendarId ?? calendar.googleCalendarId,
        },
      );
    }
    if (primary) {
      const booking = await ctx.db
        .query("bookingPages")
        .withIndex("by_user", (q) => q.eq("userId", state.userId))
        .unique();
      const connections = await ctx.db
        .query("calendarConnections")
        .withIndex("by_user", (q) => q.eq("userId", state.userId))
        .take(101);
      if (connections.length > 100) {
        throw new Error("Too many connections to choose a booking target safely");
      }
      const preferred = connections
        .filter((row) => row.status === "active")
        .sort(
          (a, b) =>
            Number(b.provider === "google") - Number(a.provider === "google") ||
            a.createdAt - b.createdAt ||
            a._creationTime - b._creationTime,
        )[0];
      if (
        booking &&
        !booking.targetConnectionId &&
        !booking.targetCalendarId &&
        preferred?._id === args.connectionId
      ) {
        await ctx.db.patch(booking._id, {
          targetConnectionId: args.connectionId,
          targetCalendarId: primary,
        });
      }
    }
    return stored;
  },
});

export const cleanupRemovedCalendarEvents = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    localCalendarId: v.id("calendars"),
    providerCalendarId: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) return null;
    const readded = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q
          .eq("userId", connection.userId)
          .eq("googleCalendarId", args.providerCalendarId),
      )
      .first();
    if (readded) return null;
    const events = await ctx.db
      .query("events")
      .withIndex("by_user_and_calendar_and_end", (q) =>
        q
          .eq("userId", connection.userId)
          .eq("calendarId", args.providerCalendarId),
      )
      .take(BATCH_SIZE);
    for (const row of events) {
      if (row.connectionId !== undefined && row.connectionId !== args.connectionId)
        continue;
      await ctx.db.delete(row._id);
    }
    const series = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q
          .eq("userId", connection.userId)
          .eq("calendarId", args.providerCalendarId),
      )
      .take(BATCH_SIZE);
    for (const row of series) {
      if (row.connectionId !== undefined && row.connectionId !== args.connectionId)
        continue;
      await ctx.db.delete(row._id);
    }
    if (
      events.length === BATCH_SIZE ||
      series.length === BATCH_SIZE
    ) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendarSync.cleanupRemovedCalendarEvents,
        args,
      );
    }
    return null;
  },
});

/** Drain an orphan cleanup queued before connection-scoped arguments shipped. */
export const cleanupLegacyRemovedCalendarEvents = defineMutation({
  args: { userId: v.string(), googleCalendarId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const readded = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q
          .eq("userId", args.userId)
          .eq("googleCalendarId", args.googleCalendarId),
      )
      .first();
    if (readded) return null;
    const rows = await ctx.db
      .query("events")
      .withIndex("by_user_and_calendar_and_end", (q) =>
        q.eq("userId", args.userId).eq("calendarId", args.googleCalendarId),
      )
      .take(BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    const series = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q.eq("userId", args.userId).eq("calendarId", args.googleCalendarId),
      )
      .take(BATCH_SIZE);
    for (const row of series) await ctx.db.delete(row._id);
    if (rows.length === BATCH_SIZE || series.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendarSync.cleanupLegacyRemovedCalendarEvents,
        args,
      );
    }
    return null;
  },
});

export const beginCalendarFullResync = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    localCalendarId: v.id("calendars"),
  },
  handler: async (ctx, args): Promise<number | null> => {
    if (!(await liveState(ctx, args.connectionId, args.attemptId))) return null;
    const calendar = await ctx.db.get(args.localCalendarId);
    if (calendar?.connectionId !== args.connectionId) return null;
    const generation = (calendar.syncGeneration ?? 0) + 1;
    await ctx.db.patch(calendar._id, {
      syncGeneration: generation,
      syncGenerationAttemptId: args.attemptId,
    });
    return generation;
  },
});

export const upsertEventsPage = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    localCalendarId: v.id("calendars"),
    events: v.array(providerEventValidator),
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const state = await liveState(ctx, args.connectionId, args.attemptId);
    const calendar = await ctx.db.get(args.localCalendarId);
    if (!state || calendar?.connectionId !== args.connectionId) return false;
    if (
      args.syncGeneration !== undefined &&
      (calendar.syncGeneration !== args.syncGeneration ||
        calendar.syncGenerationAttemptId !== args.attemptId)
    ) return false;
    const harvested: PersonInput[] = [];
    for (const event of args.events) {
      if (event.calendarId !== calendar.providerCalendarId) return false;
      const candidates = await ctx.db
        .query("events")
        .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
          q
            .eq("userId", state.userId)
            .eq("calendarId", calendar.googleCalendarId)
            .eq("googleEventId", event.id),
        )
        .collect();
      const current = candidates.find(
        (row) =>
          (row.connectionId === undefined ||
            row.connectionId === args.connectionId) &&
          (row.localCalendarId === undefined ||
            row.localCalendarId === args.localCalendarId),
      );
      if (event.status === "cancelled") {
        // A full pass swaps generations only after every page is durable. Leave
        // the old row visible until the final sweep; incremental tombstones can
        // remove immediately because their cursor still commits last.
        if (current && args.syncGeneration === undefined) {
          await ctx.db.delete(current._id);
        }
        continue;
      }
      const doc = storedEvent(
        state.userId,
        args.connectionId,
        args.localCalendarId,
        event,
        args.syncGeneration,
      );
      if (current) await ctx.db.replace(current._id, doc);
      else await ctx.db.insert("events", doc);
      harvested.push(...eventPeople(event));
    }
    await upsertPeople(ctx, state.userId, "attendee", harvested);
    return true;
  },
});

export const sweepStaleCalendarEventsBatch = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    localCalendarId: v.id("calendars"),
    keepGeneration: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    if (!(await liveState(ctx, args.connectionId, args.attemptId))) {
      throw new StaleSyncAttemptError();
    }
    const calendar = await ctx.db.get(args.localCalendarId);
    if (!calendar || calendar.connectionId !== args.connectionId) {
      throw new StaleSyncAttemptError();
    }
    if (
      calendar.syncGeneration !== args.keepGeneration ||
      calendar.syncGenerationAttemptId !== args.attemptId
    ) throw new StaleSyncAttemptError();
    const page = await ctx.db
      .query("events")
      .withIndex("by_user_and_calendar_and_end", (q) =>
        q
          .eq("userId", calendar.userId)
          .eq("calendarId", calendar.googleCalendarId),
      )
      .paginate({ cursor: args.cursor, numItems: BATCH_SIZE });
    let deleted = 0;
    for (const row of page.page) {
      if (
        (row.localCalendarId === undefined ||
          row.localCalendarId === args.localCalendarId) &&
        row.syncGeneration !== args.keepGeneration
      ) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    return { cursor: page.continueCursor, done: page.isDone, deleted };
  },
});

export const commitCalendarFullResync = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    localCalendarId: v.id("calendars"),
    syncGeneration: v.number(),
    syncCursor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    if (!(await liveState(ctx, args.connectionId, args.attemptId))) return false;
    const row = await ctx.db.get(args.localCalendarId);
    if (
      row?.connectionId !== args.connectionId ||
      row.syncGeneration !== args.syncGeneration ||
      row.syncGenerationAttemptId !== args.attemptId
    ) return false;
    await ctx.db.patch(row._id, {
      syncGenerationAttemptId: undefined,
      syncCursor: args.syncCursor,
      syncToken: args.syncCursor,
      lastSyncAt: Date.now(),
    });
    return true;
  },
});

export const setCalendarSyncCursor = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    localCalendarId: v.id("calendars"),
    syncCursor: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    if (!(await liveState(ctx, args.connectionId, args.attemptId))) return false;
    const row = await ctx.db.get(args.localCalendarId);
    if (row?.connectionId !== args.connectionId) return false;
    await ctx.db.patch(row._id, {
      syncCursor: args.syncCursor,
      syncToken: args.syncCursor,
      lastSyncAt: Date.now(),
    });
    return true;
  },
});

export const claimSharedCalendarSync = defineMutation({
  args: {
    provider: providerValidator,
    providerCalendarId: v.string(),
    refreshIntervalMs: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.provider !== "google") {
      throw new Error("Provider sync requires neutral index activation");
    }
    const row = await ctx.db
      .query("sharedCalendars")
      .withIndex("by_googleCalendarId", (q) =>
        q.eq("googleCalendarId", args.providerCalendarId),
      )
      .first();
    if (
      row &&
      (((row.syncLeaseExpiresAt ?? 0) > now && row.syncAttemptId) ||
        (row.lastSyncAt !== undefined &&
          now - row.lastSyncAt < args.refreshIntervalMs))
    ) {
      return { attemptId: null as string | null };
    }
    const attemptId = crypto.randomUUID();
    if (row) {
      await ctx.db.patch(row._id, {
        provider: args.provider,
        providerCalendarId: args.providerCalendarId,
        syncAttemptId: attemptId,
        syncLeaseExpiresAt: now + SHARED_LEASE_MS,
      });
      return {
        attemptId,
        syncCursor: row.syncCursor ?? row.syncToken,
      };
    }
    await ctx.db.insert("sharedCalendars", {
      googleCalendarId: args.providerCalendarId,
      provider: args.provider,
      providerCalendarId: args.providerCalendarId,
      syncAttemptId: attemptId,
      syncLeaseExpiresAt: now + SHARED_LEASE_MS,
    });
    return { attemptId };
  },
});

export const beginSharedFullResync = defineMutation({
  args: {
    provider: providerValidator,
    providerCalendarId: v.string(),
    attemptId: v.string(),
  },
  handler: async (ctx, args): Promise<number | null> => {
    const row = await sharedLease(
      ctx,
      args.provider,
      args.providerCalendarId,
      args.attemptId,
    );
    if (!row) return null;
    const generation = (row.syncGeneration ?? 0) + 1;
    await ctx.db.patch(row._id, {
      syncGeneration: generation,
      syncGenerationAttemptId: args.attemptId,
    });
    return generation;
  },
});

async function sharedLease(
  ctx: MutationCtx,
  provider: ProviderId,
  providerCalendarId: string,
  attemptId: string,
) {
  if (provider !== "google") return null;
  const row = await ctx.db
    .query("sharedCalendars")
    .withIndex("by_googleCalendarId", (q) =>
      q.eq("googleCalendarId", providerCalendarId),
    )
    .first();
  return row?.syncAttemptId === attemptId &&
    (row.provider ?? "google") === provider &&
    (row.providerCalendarId ?? row.googleCalendarId) === providerCalendarId &&
    (row.syncLeaseExpiresAt ?? 0) > Date.now()
    ? row
    : null;
}

export const heartbeatSharedCalendarLease = defineMutation({
  args: {
    provider: providerValidator,
    providerCalendarId: v.string(),
    attemptId: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await sharedLease(
      ctx,
      args.provider,
      args.providerCalendarId,
      args.attemptId,
    );
    if (!row) return false;
    await ctx.db.patch(row._id, {
      syncLeaseExpiresAt: Date.now() + SHARED_LEASE_MS,
    });
    return true;
  },
});

export const releaseSharedCalendarLease = defineMutation({
  args: {
    provider: providerValidator,
    providerCalendarId: v.string(),
    attemptId: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await sharedLease(
      ctx,
      args.provider,
      args.providerCalendarId,
      args.attemptId,
    );
    if (row) {
      await ctx.db.patch(row._id, {
        syncAttemptId: undefined,
        syncLeaseExpiresAt: undefined,
      });
    }
    return null;
  },
});

export const upsertSharedEventsPage = defineMutation({
  args: {
    provider: providerValidator,
    providerCalendarId: v.string(),
    attemptId: v.string(),
    events: v.array(providerEventValidator),
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const lease = await sharedLease(
      ctx,
      args.provider,
      args.providerCalendarId,
      args.attemptId,
    );
    if (!lease) return false;
    if (
      args.syncGeneration !== undefined &&
      (lease.syncGeneration !== args.syncGeneration ||
        lease.syncGenerationAttemptId !== args.attemptId)
    ) return false;
    for (const event of args.events) {
      const candidates = await ctx.db
        .query("sharedEvents")
        .withIndex("by_calendar_and_googleEventId", (q) =>
          q
            .eq("calendarId", args.providerCalendarId)
            .eq("googleEventId", event.id),
        )
        .collect();
      const current = candidates.find(
        (row) =>
          (row.provider ?? "google") === args.provider &&
          (row.providerCalendarId ?? row.calendarId) === args.providerCalendarId,
      );
      if (event.status === "cancelled") {
        if (current && args.syncGeneration === undefined) {
          await ctx.db.delete(current._id);
        }
        continue;
      }
      const doc = {
        ...storedEvent(
          "shared",
          "" as Id<"calendarConnections">,
          "" as Id<"calendars">,
          event,
          args.syncGeneration,
        ),
      };
      const sharedDoc = {
        googleEventId: doc.googleEventId,
        calendarId: args.providerCalendarId,
        summary: doc.summary,
        description: doc.description,
        location: doc.location,
        startMs: doc.startMs,
        endMs: doc.endMs,
        allDay: doc.allDay,
        status: doc.status,
        htmlLink: doc.htmlLink,
        colorId: doc.colorId,
        visibility: doc.visibility,
        transparency: doc.transparency,
        attendees: doc.attendees,
        attendeesOmitted: doc.attendeesOmitted,
        googleUpdatedMs: doc.googleUpdatedMs,
        organizer: doc.organizer,
        creator: doc.creator,
        guestsCanModify: doc.guestsCanModify,
        guestsCanInviteOthers: doc.guestsCanInviteOthers,
        guestsCanSeeOtherGuests: doc.guestsCanSeeOtherGuests,
        locked: doc.locked,
        eventType: doc.eventType,
        recurringEventId: doc.recurringEventId,
        hangoutLink: doc.hangoutLink,
        conferenceUrl: doc.conferenceUrl,
        conferenceName: doc.conferenceName,
        conferenceType: doc.conferenceType,
        provider: args.provider,
        providerCalendarId: args.providerCalendarId,
        providerEventId: event.id,
        providerUpdatedMs: event.updatedMs,
        providerSeriesId: event.seriesId,
        color: event.color,
        busy: event.busy,
        syncGeneration: args.syncGeneration,
      };
      if (current) await ctx.db.replace(current._id, sharedDoc);
      else await ctx.db.insert("sharedEvents", sharedDoc);
    }
    return true;
  },
});

export const sweepStaleSharedEventsBatch = defineMutation({
  args: {
    provider: providerValidator,
    providerCalendarId: v.string(),
    attemptId: v.string(),
    keepGeneration: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const lease = await sharedLease(
      ctx,
      args.provider,
      args.providerCalendarId,
      args.attemptId,
    );
    if (
      !lease ||
      lease.syncGeneration !== args.keepGeneration ||
      lease.syncGenerationAttemptId !== args.attemptId
    ) throw new StaleSyncAttemptError();
    const page = await ctx.db
      .query("sharedEvents")
      .withIndex("by_calendar_and_googleEventId", (q) =>
        q
          .eq("calendarId", args.providerCalendarId),
      )
      .paginate({ cursor: args.cursor, numItems: BATCH_SIZE });
    for (const row of page.page) {
      if (
        (row.provider === undefined || row.provider === args.provider) &&
        (row.providerCalendarId === undefined ||
          row.providerCalendarId === args.providerCalendarId) &&
        row.syncGeneration !== args.keepGeneration
      ) {
        await ctx.db.delete(row._id);
      }
    }
    return { cursor: page.continueCursor, done: page.isDone };
  },
});

export const commitSharedCalendarSync = defineMutation({
  args: {
    provider: providerValidator,
    providerCalendarId: v.string(),
    attemptId: v.string(),
    syncCursor: v.optional(v.string()),
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await sharedLease(
      ctx,
      args.provider,
      args.providerCalendarId,
      args.attemptId,
    );
    if (!row) return false;
    if (
      args.syncGeneration !== undefined &&
      (row.syncGeneration !== args.syncGeneration ||
        row.syncGenerationAttemptId !== args.attemptId)
    ) return false;
    await ctx.db.patch(row._id, {
      syncCursor: args.syncCursor,
      syncToken: args.syncCursor,
      syncGeneration: args.syncGeneration ?? row.syncGeneration,
      syncGenerationAttemptId:
        args.syncGeneration === undefined
          ? row.syncGenerationAttemptId
          : undefined,
      lastSyncAt: Date.now(),
      syncAttemptId: undefined,
      syncLeaseExpiresAt: undefined,
    });
    return true;
  },
});

export const beginContactsFullResync = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    feed: v.union(v.literal("contacts"), v.literal("other")),
  },
  handler: async (ctx, args): Promise<number | null> => {
    const state = await liveState(ctx, args.connectionId, args.attemptId);
    if (!state) return null;
    const generation = (
      (args.feed === "contacts"
        ? state.contactsGeneration
        : state.otherContactsGeneration) ?? 0
    ) + 1;
    await ctx.db.patch(
      state._id,
      args.feed === "contacts"
        ? {
            contactsGeneration: generation,
            contactsGenerationAttemptId: args.attemptId,
          }
        : {
            otherContactsGeneration: generation,
            otherContactsGenerationAttemptId: args.attemptId,
          },
    );
    await mirrorLegacySyncState(
      ctx,
      state.userId,
      args.feed === "contacts"
        ? { contactsSyncGeneration: generation }
        : { otherContactsSyncGeneration: generation },
    );
    return generation;
  },
});

export const upsertContactsPage = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    feed: v.union(v.literal("contacts"), v.literal("other")),
    contacts: v.array(providerContactValidator),
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const state = await liveState(ctx, args.connectionId, args.attemptId);
    if (!state) return false;
    if (
      args.syncGeneration !== undefined &&
      (args.feed === "contacts"
        ? state.contactsGeneration !== args.syncGeneration ||
          state.contactsGenerationAttemptId !== args.attemptId
        : state.otherContactsGeneration !== args.syncGeneration ||
          state.otherContactsGenerationAttemptId !== args.attemptId)
    ) return false;
    const source = args.feed === "contacts" ? "connection" : "other";
    const people: PersonInput[] = [];
    for (const contact of args.contacts as ProviderContact[]) {
      const neutralRow =
        args.feed === "contacts"
          ? null
          : await ctx.db
              .query("otherContactSources")
              .withIndex("by_connection_and_providerContactId", (q) =>
                q
                  .eq("connectionId", args.connectionId)
                  .eq("providerContactId", contact.id),
              )
              .unique();
      const legacyContacts =
        args.feed === "contacts"
          ? await ctx.db
              .query("contacts")
              .withIndex("by_user_and_resourceName", (q) =>
                q
                  .eq("userId", state.userId)
                  .eq("resourceName", contact.id),
              )
              .collect()
          : null;
      const legacyContact = legacyContacts?.find(
        (row) =>
          row.connectionId === undefined ||
          row.connectionId === args.connectionId,
      );
      const tableRow = neutralRow ?? legacyContact;
      const oldEmails = tableRow?.emails ?? [];
      if (contact.deleted) {
        for (const email of oldEmails.length ? oldEmails : contact.emails) {
          await releasePersonSource(
            ctx,
            state.userId,
            args.connectionId,
            source,
            contact.id,
            email,
          );
        }
        if (tableRow) await ctx.db.delete(tableRow._id);
        continue;
      }
      const nextEmails = contact.emails.map((email) => email.trim().toLowerCase());
      for (const email of oldEmails) {
        if (!nextEmails.includes(email.trim().toLowerCase())) {
          await releasePersonSource(
            ctx,
            state.userId,
            args.connectionId,
            source,
            contact.id,
            email,
          );
        }
      }
      for (const email of nextEmails) {
        await claimPersonSource(
          ctx,
          state.userId,
          args.connectionId,
          source,
          contact.id,
          email,
          args.syncGeneration,
        );
        people.push({
          email,
          displayName: contact.displayName,
          photoUrl: contact.photoUrl,
        });
      }
      if (args.feed === "contacts") {
        const doc = {
          userId: state.userId,
          resourceName: contact.id,
          displayName: contact.displayName,
          emails: nextEmails,
          phones: [...contact.phones],
          photoUrl: contact.photoUrl,
          googleEtag: contact.version,
          syncGeneration: args.syncGeneration ?? tableRow?.syncGeneration,
          connectionId: args.connectionId,
          providerContactId: contact.id,
          providerVersion: contact.version,
        };
        if (tableRow) await ctx.db.replace(tableRow._id as Id<"contacts">, doc);
        else await ctx.db.insert("contacts", doc);
      } else {
        const doc = {
          userId: state.userId,
          connectionId: args.connectionId,
          providerContactId: contact.id,
          emails: nextEmails,
          syncGeneration: args.syncGeneration ?? tableRow?.syncGeneration,
        };
        if (tableRow) {
          await ctx.db.replace(tableRow._id as Id<"otherContactSources">, doc);
        } else await ctx.db.insert("otherContactSources", doc);
      }
    }
    await upsertPeople(ctx, state.userId, source, people);
    return true;
  },
});

export const sweepStaleContactsBatch = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    feed: v.union(v.literal("contacts"), v.literal("other")),
    keepGeneration: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const state = await liveState(ctx, args.connectionId, args.attemptId);
    if (!state) throw new StaleSyncAttemptError();
    if (
      args.feed === "contacts"
        ? state.contactsGeneration !== args.keepGeneration ||
          state.contactsGenerationAttemptId !== args.attemptId
        : state.otherContactsGeneration !== args.keepGeneration ||
          state.otherContactsGenerationAttemptId !== args.attemptId
    ) throw new StaleSyncAttemptError();
    const page =
      args.feed === "contacts"
        ? await ctx.db
            .query("contacts")
            .withIndex("by_user", (q) => q.eq("userId", state.userId))
            .paginate({ cursor: args.cursor, numItems: BATCH_SIZE })
        : await ctx.db
            .query("otherContactSources")
            .withIndex("by_connection_and_providerContactId", (q) =>
              q.eq("connectionId", args.connectionId),
            )
            .paginate({ cursor: args.cursor, numItems: BATCH_SIZE });
    let deleted = 0;
    for (const row of page.page) {
      if (
        row.connectionId !== undefined &&
        row.connectionId !== args.connectionId
      ) continue;
      if (row.syncGeneration === args.keepGeneration) continue;
      for (const email of row.emails) {
        await releasePersonSource(
          ctx,
          state.userId,
          args.connectionId,
          args.feed === "contacts" ? "connection" : "other",
          row.providerContactId ??
            ("resourceName" in row ? row.resourceName : ""),
          email,
        );
      }
      await ctx.db.delete(row._id);
      deleted++;
    }
    return { cursor: page.continueCursor, done: page.isDone, deleted };
  },
});

/** First full Other Contacts sync removes legacy `people.sources: ["other"]`
 * rows that predate contact-scoped claims and were not reclaimed by this pass. */
export const sweepLegacyOtherPeopleBatch = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const state = await liveState(ctx, args.connectionId, args.attemptId);
    if (!state) throw new StaleSyncAttemptError();
    if (state.otherContactsGenerationAttemptId !== args.attemptId) {
      throw new StaleSyncAttemptError();
    }
    const page = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", state.userId))
      .paginate({ cursor: args.cursor, numItems: BATCH_SIZE });
    let deleted = 0;
    for (const person of page.page) {
      if (!person.sources.includes("other")) continue;
      const claim = await ctx.db
        .query("personSourceClaims")
        .withIndex("by_user_and_email_and_source", (q) =>
          q
            .eq("userId", state.userId)
            .eq("email", person.email)
            .eq("source", "other"),
        )
        .first();
      if (claim) continue;
      const sources = person.sources.filter((source) => source !== "other");
      if (sources.length === 0) await ctx.db.delete(person._id);
      else {
        await ctx.db.patch(person._id, {
          sources,
          otherSyncGeneration: undefined,
          updatedAt: Date.now(),
        });
      }
      deleted++;
    }
    return { cursor: page.continueCursor, done: page.isDone, deleted };
  },
});

export const commitContactsSync = defineMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    attemptId: v.string(),
    feed: v.union(v.literal("contacts"), v.literal("other")),
    syncCursor: v.optional(v.string()),
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const state = await liveState(ctx, args.connectionId, args.attemptId);
    if (!state) return false;
    if (
      args.syncGeneration !== undefined &&
      (args.feed === "contacts"
        ? state.contactsGeneration !== args.syncGeneration ||
          state.contactsGenerationAttemptId !== args.attemptId
        : state.otherContactsGeneration !== args.syncGeneration ||
          state.otherContactsGenerationAttemptId !== args.attemptId)
    ) return false;
    const now = Date.now();
    const patch =
      args.feed === "contacts"
        ? {
            contactsCursor: args.syncCursor,
            contactsGeneration:
              args.syncGeneration ?? state.contactsGeneration,
            contactsGenerationAttemptId:
              args.syncGeneration === undefined
                ? state.contactsGenerationAttemptId
                : undefined,
            contactsLastSyncedAt: now,
          }
        : {
            otherContactsCursor: args.syncCursor,
            otherContactsGeneration:
              args.syncGeneration ?? state.otherContactsGeneration,
            otherContactsGenerationAttemptId:
              args.syncGeneration === undefined
                ? state.otherContactsGenerationAttemptId
                : undefined,
            otherContactsBackfillRequired:
              args.syncGeneration === undefined
                ? state.otherContactsBackfillRequired
                : false,
            otherContactsLastSyncedAt: now,
          };
    await ctx.db.patch(state._id, patch);
    await mirrorLegacySyncState(
      ctx,
      state.userId,
      args.feed === "contacts"
        ? {
            contactsSyncToken: args.syncCursor,
            contactsSyncGeneration:
              args.syncGeneration ?? state.contactsGeneration,
            lastContactsSyncAt: now,
          }
        : {
            otherContactsSyncToken: args.syncCursor,
            otherContactsSyncGeneration:
              args.syncGeneration ?? state.otherContactsGeneration,
            lastOtherContactsSyncAt: now,
          },
    );
    return true;
  },
});

type EngagementPage = {
  page: {
    startMs: number;
    status: string;
    attendees?: { email: string; self?: boolean }[];
  }[];
  isDone: boolean;
  continueCursor: string;
};

export const listEventsPageForEngagement = defineQuery({
  args: {
    userId: v.string(),
    sinceMs: v.number(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args): Promise<EngagementPage> => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) =>
        q.eq("userId", args.userId).gte("startMs", args.sinceMs),
      )
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    return {
      page: page.page.map((event) => ({
        startMs: event.startMs,
        status: event.status,
        attendees: event.attendees,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const applyEngagementScores = defineMutation({
  args: {
    userId: v.string(),
    scores: v.array(
      v.object({
        email: v.string(),
        score: v.number(),
        meetingCount: v.number(),
        lastMetMs: v.optional(v.number()),
        nextMeetingMs: v.optional(v.number()),
      }),
    ),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const byEmail = new Map(args.scores.map((score) => [score.email, score]));
    const page = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: 200 });
    for (const person of page.page) {
      const score = byEmail.get(person.email);
      await ctx.db.patch(person._id, {
        score: score?.score ?? 0,
        meetingCount: score?.meetingCount ?? 0,
        lastMetMs: score?.lastMetMs,
        nextMeetingMs: score?.nextMeetingMs,
      });
    }
    return { cursor: page.continueCursor, done: page.isDone };
  },
});

type EngagementScore = {
  email: string;
  score: number;
  meetingCount: number;
  lastMetMs?: number;
  nextMeetingMs?: number;
};

export function chunkEngagementScores(
  scores: EngagementScore[],
): EngagementScore[][] {
  const chunks: EngagementScore[][] = [];
  for (let index = 0; index < scores.length; index += ENGAGEMENT_CHUNK_SIZE) {
    chunks.push(scores.slice(index, index + ENGAGEMENT_CHUNK_SIZE));
  }
  return chunks;
}

async function liveEngagementAttempt(
  ctx: MutationCtx,
  userId: string,
  attemptId: string,
  generation: number,
) {
  const state = await ctx.db
    .query("userSyncState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return state?.engagementAttemptId === attemptId &&
    state.engagementGeneration === generation &&
    (state.engagementLeaseExpiresAt ?? 0) > Date.now()
    ? state
    : null;
}

export const markEngagementDirty = defineMutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const state = await ctx.db
      .query("userSyncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!state) {
      await ctx.db.insert("userSyncState", {
        userId: args.userId,
        engagementDirty: true,
        engagementGeneration: 1,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.calendarSync.recomputeEngagement, {
        userId: args.userId,
        coordinated: true,
      });
      return null;
    }
    if (!state.engagementDirty) {
      await ctx.db.patch(state._id, {
        engagementDirty: true,
        engagementGeneration: (state.engagementGeneration ?? 0) + 1,
        updatedAt: now,
      });
    }
    if (
      !state.engagementAttemptId ||
      (state.engagementLeaseExpiresAt ?? 0) <= now
    ) {
      await ctx.scheduler.runAfter(0, internal.calendarSync.recomputeEngagement, {
        userId: args.userId,
        coordinated: true,
      });
    }
    return null;
  },
});

export const claimEngagement = defineMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("userSyncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!state) return null;
    const now = Date.now();
    const leaseIsLive =
      state.engagementAttemptId &&
      (state.engagementLeaseExpiresAt ?? 0) > now;
    if (leaseIsLive || (!state.engagementDirty && !state.engagementAttemptId)) {
      return null;
    }
    const attemptId = crypto.randomUUID();
    const generation = state.engagementGeneration ?? 0;
    const leaseExpiresAt = now + ENGAGEMENT_LEASE_MS;
    await ctx.db.patch(state._id, {
      engagementDirty: false,
      engagementAttemptId: attemptId,
      engagementLeaseExpiresAt: leaseExpiresAt,
      updatedAt: now,
    });
    // If the action disappears, this invocation observes the stale attempt and
    // reclaims it. A completed attempt leaves neither a lease nor dirty work.
    await ctx.scheduler.runAt(
      leaseExpiresAt,
      internal.calendarSync.recomputeEngagement,
      { userId: args.userId, coordinated: true },
    );
    return { attemptId, generation };
  },
});

export const heartbeatEngagement = defineMutation({
  args: {
    userId: v.string(),
    attemptId: v.string(),
    generation: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const state = await liveEngagementAttempt(
      ctx,
      args.userId,
      args.attemptId,
      args.generation,
    );
    if (!state) return false;
    const leaseExpiresAt = Date.now() + ENGAGEMENT_LEASE_MS;
    await ctx.db.patch(state._id, {
      engagementLeaseExpiresAt: leaseExpiresAt,
    });
    await ctx.scheduler.runAt(
      leaseExpiresAt,
      internal.calendarSync.recomputeEngagement,
      { userId: args.userId, coordinated: true },
    );
    return true;
  },
});

const engagementScoreValidator = v.object({
  email: v.string(),
  score: v.number(),
  meetingCount: v.number(),
  lastMetMs: v.optional(v.number()),
  nextMeetingMs: v.optional(v.number()),
});

export const applyEngagementScoreChunk = defineMutation({
  args: {
    userId: v.string(),
    attemptId: v.string(),
    generation: v.number(),
    scores: v.array(engagementScoreValidator),
  },
  handler: async (ctx, args): Promise<boolean> => {
    if (args.scores.length > ENGAGEMENT_CHUNK_SIZE) {
      throw new Error("Engagement score chunk exceeds the bounded batch size");
    }
    if (
      !(await liveEngagementAttempt(
        ctx,
        args.userId,
        args.attemptId,
        args.generation,
      ))
    ) return false;
    for (const score of args.scores) {
      const person = await ctx.db
        .query("people")
        .withIndex("by_user_and_email", (q) =>
          q.eq("userId", args.userId).eq("email", score.email),
        )
        .unique();
      if (!person) continue;
      await ctx.db.patch(person._id, {
        score: score.score,
        meetingCount: score.meetingCount,
        lastMetMs: score.lastMetMs,
        nextMeetingMs: score.nextMeetingMs,
        engagementGeneration: args.generation,
      });
    }
    return true;
  },
});

export const resetStaleEngagementScores = defineMutation({
  args: {
    userId: v.string(),
    attemptId: v.string(),
    generation: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    if (
      !(await liveEngagementAttempt(
        ctx,
        args.userId,
        args.attemptId,
        args.generation,
      ))
    ) return null;
    const page = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: ENGAGEMENT_CHUNK_SIZE });
    for (const person of page.page) {
      if (person.engagementGeneration === args.generation) continue;
      await ctx.db.patch(person._id, {
        score: 0,
        meetingCount: 0,
        lastMetMs: undefined,
        nextMeetingMs: undefined,
        engagementGeneration: args.generation,
      });
    }
    return { cursor: page.continueCursor, done: page.isDone };
  },
});

export const finishEngagement = defineMutation({
  args: {
    userId: v.string(),
    attemptId: v.string(),
    generation: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const state = await ctx.db
      .query("userSyncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (state?.engagementAttemptId !== args.attemptId) return false;
    const rerun =
      state.engagementDirty || state.engagementGeneration !== args.generation;
    await ctx.db.patch(state._id, {
      engagementAttemptId: undefined,
      engagementLeaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });
    if (rerun) {
      await ctx.scheduler.runAfter(0, internal.calendarSync.recomputeEngagement, {
        userId: args.userId,
        coordinated: true,
      });
    }
    return !rerun;
  },
});

async function recomputeEngagementForUser(
  ctx: ActionCtx,
  userId: string,
): Promise<void> {
  const claim: { attemptId: string; generation: number } | null =
    await ctx.runMutation(internal.calendarSync.claimEngagement, { userId });
  if (!claim) return;
  const now = Date.now();
  const scores = new Map<
    string,
    { score: number; meetingCount: number; lastMetMs?: number; nextMeetingMs?: number }
  >();
  let cursor: string | null = null;
  for (;;) {
    const live: boolean = await ctx.runMutation(
      internal.calendarSync.heartbeatEngagement,
      { userId, ...claim },
    );
    if (!live) break;
    const page: EngagementPage = await ctx.runQuery(
      internal.calendarSync.listEventsPageForEngagement,
      { userId, sinceMs: now - CALENDAR_HISTORY_MS, cursor, numItems: 200 },
    );
    for (const event of page.page) {
      if (event.status === "cancelled") continue;
      const attendees = event.attendees ?? [];
      const ageDays = Math.abs(now - event.startMs) / DAY_MS;
      const weight =
        2 ** (-ageDays / 30) /
        Math.log2(Math.max(attendees.length, 2) + 1) *
        (event.startMs > now ? 1.6 : 1);
      for (const attendee of attendees) {
        const email = attendee.email?.trim().toLowerCase();
        if (!email || attendee.self) continue;
        const score = scores.get(email) ?? { score: 0, meetingCount: 0 };
        score.score += weight;
        score.meetingCount++;
        if (event.startMs <= now) {
          score.lastMetMs = Math.max(score.lastMetMs ?? 0, event.startMs);
        } else {
          score.nextMeetingMs = Math.min(
            score.nextMeetingMs ?? Infinity,
            event.startMs,
          );
        }
        scores.set(email, score);
      }
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  const values = [...scores].map(([email, score]) => ({ email, ...score }));
  try {
    for (const chunk of chunkEngagementScores(values)) {
      const live: boolean = await ctx.runMutation(
        internal.calendarSync.heartbeatEngagement,
        { userId, ...claim },
      );
      if (!live) return;
      const wrote: boolean = await ctx.runMutation(
        internal.calendarSync.applyEngagementScoreChunk,
        { userId, ...claim, scores: chunk },
      );
      if (!wrote) return;
    }
    let peopleCursor: string | null = null;
    let done = false;
    while (!done) {
      const live: boolean = await ctx.runMutation(
        internal.calendarSync.heartbeatEngagement,
        { userId, ...claim },
      );
      if (!live) return;
      const result: { cursor: string | null; done: boolean } | null =
        await ctx.runMutation(internal.calendarSync.resetStaleEngagementScores, {
          userId,
          ...claim,
          cursor: peopleCursor,
        });
      if (!result) return;
      peopleCursor = result.cursor;
      done = result.done;
    }
  } finally {
    await ctx.runMutation(internal.calendarSync.finishEngagement, {
      userId,
      ...claim,
    });
  }
}

export const recomputeEngagement = defineAction({
  args: { userId: v.string(), coordinated: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<null> => {
    try {
      // Calls queued before dirty-state coordination shipped have no marker.
      // Materialize their work once; markEngagementDirty's coordinated schedule
      // becomes a harmless no-op after this invocation completes.
      if (!args.coordinated) {
        await ctx.runMutation(internal.calendarSync.markEngagementDirty, {
          userId: args.userId,
        });
      }
      await recomputeEngagementForUser(ctx, args.userId);
    } catch (error) {
      console.error(
        `Engagement recompute failed for ${args.userId}:`,
        error instanceof Error ? error.message : error,
      );
    }
    return null;
  },
});

export const enqueueEngagementRefresh = defineMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("userSyncState")
      .paginate({ cursor: args.cursor ?? null, numItems: FANOUT_BATCH });
    for (const state of page.page) {
      await ctx.runMutation(internal.calendarSync.markEngagementDirty, {
        userId: state.userId,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendarSync.enqueueEngagementRefresh,
        { cursor: page.continueCursor },
      );
    }
    return null;
  },
});

export const backfillPeople = defineMutation({
  args: {
    phase: v.optional(v.union(v.literal("contacts"), v.literal("events"))),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const phase = args.phase ?? "contacts";
    const page = await ctx.db
      .query(phase === "contacts" ? "contacts" : "events")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    if (phase === "contacts") {
      for (const contact of page.page as Doc<"contacts">[]) {
        await upsertPeople(
          ctx,
          contact.userId,
          "connection",
          contact.emails.map((email) => ({
            email,
            displayName: contact.displayName,
            photoUrl: contact.photoUrl,
          })),
        );
      }
    } else {
      for (const event of page.page as Doc<"events">[]) {
        await upsertPeople(
          ctx,
          event.userId,
          "attendee",
          (event.attendees ?? [])
            .filter((row) => !row.self)
            .map((row) => ({ email: row.email, displayName: row.displayName })),
        );
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.calendarSync.backfillPeople, {
        phase,
        cursor: page.continueCursor,
      });
    } else if (phase === "contacts") {
      await ctx.scheduler.runAfter(0, internal.calendarSync.backfillPeople, {
        phase: "events",
      });
    }
    return null;
  },
});

/** Canonical seam used after provider writes to re-expand a single calendar. */
export async function refreshConnectionCalendar(
  ctx: ActionCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
  localCalendarId: Id<"calendars">,
): Promise<void> {
  const attemptId: string | null = await ctx.runMutation(
    internal.calendarSync.claimSyncLease,
    { connectionId },
  );
  if (!attemptId) return;
  try {
    const adapter = await getCalendarAdapter(ctx, connectionId);
    const calendars: Doc<"calendars">[] = await ctx.runQuery(
      internal.calendarSync.listCalendarsForUser,
      { userId },
    );
    const calendar = calendars.find(
      (row) => row._id === localCalendarId && row.connectionId === connectionId,
    );
    if (!calendar) throw new Error("Calendar refresh target is unavailable");
    const changed = await syncOneConnectionCalendar(ctx, adapter, {
      connectionId,
      attemptId,
      localCalendarId,
      providerCalendarId:
        calendar.providerCalendarId ?? calendar.googleCalendarId,
      syncCursor: calendar.syncCursor ?? calendar.syncToken,
    });
    if (changed) {
      await ctx.runMutation(internal.calendarSync.markEngagementDirty, { userId });
    }
    await ctx.runMutation(internal.calendarSync.recordSyncOutcome, {
      connectionId,
      attemptId,
      status: "idle",
      active: changed,
    });
  } catch (error) {
    await ctx.runMutation(internal.calendarSync.recordSyncOutcome, {
      connectionId,
      attemptId,
      status: "error",
      active: false,
      lastError: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Old mutation names remain registered as harmless compatibility definitions.
export const clearCalendarEventsBatch = defineMutation({
  args: { userId: v.string(), googleCalendarId: v.string() },
  handler: async (): Promise<boolean> => false,
});
export const clearSharedCalendarEventsBatch = defineMutation({
  args: { googleCalendarId: v.string() },
  handler: async (): Promise<boolean> => false,
});
