/**
 * Exact pre-cutover `internal.googleSync.*` mutation/query contracts used by an
 * action that was already running when the connection engine deployed.
 *
 * Removal gate: delete these definitions only after the scheduler and running
 * function views have shown no googleSync target for the runbook drain window.
 */
import { v, type Infer } from "convex/values";

import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { ensureGoogleConnection } from "../calendar/connections";
import { googleEventValidator } from "../calendar/validators";
import { defineMutation, defineQuery } from "../../shared/functionDefinitions";

const BATCH_SIZE = 100;
const SYNC_MIN_MS = 15 * 60 * 1000;
const SYNC_MAX_MS = 60 * 60 * 1000;
const SYNC_LEASE_MS = 10 * 60 * 1000;
const SHARED_LEASE_MS = 5 * 60 * 1000;
const LEGACY_SHARED_ATTEMPT = "legacy-google-sync:";

const contactValidator = v.object({
  resourceName: v.string(),
  deleted: v.boolean(),
  displayName: v.optional(v.string()),
  emails: v.array(v.string()),
  phones: v.array(v.string()),
  photoUrl: v.optional(v.string()),
  googleEtag: v.optional(v.string()),
});

const calendarValidator = v.object({
  googleCalendarId: v.string(),
  summary: v.optional(v.string()),
  summaryOverride: v.optional(v.string()),
  backgroundColor: v.optional(v.string()),
  foregroundColor: v.optional(v.string()),
  primary: v.optional(v.boolean()),
  accessRole: v.optional(v.string()),
  timeZone: v.optional(v.string()),
  googleSelected: v.optional(v.boolean()),
});

async function liveLegacyState(ctx: MutationCtx, userId: string) {
  const row = await ctx.db
    .query("syncState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return row?.syncAttemptId && (row.syncLeaseExpiresAt ?? 0) > Date.now()
    ? row
    : null;
}

async function googleState(ctx: MutationCtx, userId: string) {
  const connectionId = await ensureGoogleConnection(ctx, userId);
  const state = await ctx.db
    .query("connectionSyncState")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .unique();
  return state ? { connectionId, state } : null;
}

async function upsertPerson(
  ctx: MutationCtx,
  userId: string,
  source: "connection" | "other" | "attendee",
  emailValue: string,
  displayName?: string,
  photoUrl?: string,
  otherGeneration?: number,
) {
  const email = emailValue.trim().toLowerCase();
  if (!email) return;
  const row = await ctx.db
    .query("people")
    .withIndex("by_user_and_email", (q) =>
      q.eq("userId", userId).eq("email", email),
    )
    .unique();
  if (row) {
    const authoritative = source !== "attendee";
    await ctx.db.patch(row._id, {
      displayName: authoritative
        ? (displayName ?? row.displayName)
        : (row.displayName ?? displayName),
      photoUrl: authoritative ? (photoUrl ?? row.photoUrl) : row.photoUrl,
      sources: row.sources.includes(source) ? row.sources : [...row.sources, source],
      otherSyncGeneration:
        source === "other" && otherGeneration !== undefined
          ? otherGeneration
          : row.otherSyncGeneration,
      updatedAt: Date.now(),
    });
  } else {
    await ctx.db.insert("people", {
      userId,
      email,
      displayName,
      photoUrl,
      sources: [source],
      otherSyncGeneration:
        source === "other" ? otherGeneration : undefined,
      updatedAt: Date.now(),
    });
  }
}

async function claimSource(
  ctx: MutationCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
  source: "connection" | "other",
  providerContactId: string,
  emailValue: string,
  generation?: number,
) {
  const email = emailValue.trim().toLowerCase();
  if (!email) return;
  const claims = await ctx.db
    .query("personSourceClaims")
    .withIndex("by_connection_and_source_and_email", (q) =>
      q.eq("connectionId", connectionId).eq("source", source).eq("email", email),
    )
    .collect();
  const exact = claims.find((row) => row.providerContactId === providerContactId);
  const value = {
    userId,
    connectionId,
    source,
    providerContactId,
    email,
    syncGeneration: generation,
    updatedAt: Date.now(),
  };
  if (exact) await ctx.db.patch(exact._id, value);
  else await ctx.db.insert("personSourceClaims", value);
}

async function releaseSource(
  ctx: MutationCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
  source: "connection" | "other",
  providerContactId: string,
  emailValue: string,
) {
  const email = emailValue.trim().toLowerCase();
  if (!email) return;
  const claims = await ctx.db
    .query("personSourceClaims")
    .withIndex("by_connection_and_source_and_email", (q) =>
      q.eq("connectionId", connectionId).eq("source", source).eq("email", email),
    )
    .collect();
  const exact = claims.find((row) => row.providerContactId === providerContactId);
  if (exact) await ctx.db.delete(exact._id);
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
  if (!person) return;
  const sources = person.sources.filter((item) => item !== source);
  if (sources.length === 0) await ctx.db.delete(person._id);
  else await ctx.db.patch(person._id, { sources, updatedAt: Date.now() });
}

export const getSyncState = defineQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique(),
});

export const listCalendarsForUser = defineQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect(),
});

export const ensureSyncState = defineMutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    await ensureGoogleConnection(ctx, args.userId);
    const row = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!row) {
      await ctx.db.insert("syncState", {
        userId: args.userId,
        status: "idle",
        nextSyncDueAt: 0,
        syncIntervalMs: SYNC_MIN_MS,
      });
    }
    return null;
  },
});

export const claimSyncLease = defineMutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!row || (row.syncAttemptId && (row.syncLeaseExpiresAt ?? 0) > Date.now())) {
      return null;
    }
    const attemptId = crypto.randomUUID();
    const patch = {
      status: "syncing" as const,
      syncAttemptId: attemptId,
      syncLeaseExpiresAt: Date.now() + SYNC_LEASE_MS,
    };
    await ctx.db.patch(row._id, patch);
    const neutral = await googleState(ctx, args.userId);
    if (neutral) await ctx.db.patch(neutral.state._id, patch);
    return attemptId;
  },
});

export const recordSyncOutcome = defineMutation({
  args: {
    userId: v.string(),
    attemptId: v.string(),
    status: v.union(v.literal("idle"), v.literal("error")),
    active: v.boolean(),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!row || row.syncAttemptId !== args.attemptId) return null;
    const interval = args.active
      ? SYNC_MIN_MS
      : Math.min((row.syncIntervalMs ?? SYNC_MIN_MS) * 2, SYNC_MAX_MS);
    const patch = {
      status: args.status,
      lastError: args.status === "error" ? args.lastError : undefined,
      syncIntervalMs: interval,
      nextSyncDueAt: Date.now() + interval,
      syncAttemptId: undefined,
      syncLeaseExpiresAt: undefined,
    };
    await ctx.db.patch(row._id, patch);
    const neutral = await googleState(ctx, args.userId);
    if (neutral?.state.syncAttemptId === args.attemptId) {
      await ctx.db.patch(neutral.state._id, patch);
    }
    return null;
  },
});

export const reconcileCalendars = defineMutation({
  args: { userId: v.string(), calendars: v.array(calendarValidator) },
  handler: async (ctx, args): Promise<{ googleCalendarId: string; syncToken?: string }[]> => {
    if (!(await liveLegacyState(ctx, args.userId))) return [];
    const connectionId = await ensureGoogleConnection(ctx, args.userId);
    const existing = await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const byId = new Map(existing.map((row) => [row.googleCalendarId, row]));
    const seen = new Set(args.calendars.map((row) => row.googleCalendarId));
    const stored: { googleCalendarId: string; syncToken?: string }[] = [];
    for (const calendar of args.calendars) {
      const current = byId.get(calendar.googleCalendarId);
      const value = {
        ...calendar,
        connectionId,
        providerCalendarId: calendar.googleCalendarId,
        syncCursor: current?.syncToken,
      };
      if (current) await ctx.db.patch(current._id, value);
      else {
        await ctx.db.insert("calendars", {
          userId: args.userId,
          selected: calendar.googleSelected ?? false,
          ...value,
        });
      }
      stored.push({
        googleCalendarId: calendar.googleCalendarId,
        syncToken: current?.syncToken,
      });
    }
    for (const row of existing) {
      if (seen.has(row.googleCalendarId)) continue;
      await ctx.db.delete(row._id);
      await ctx.scheduler.runAfter(
        0,
        internal.googleSync.cleanupRemovedCalendarEvents,
        { userId: args.userId, googleCalendarId: row.googleCalendarId },
      );
    }
    return stored;
  },
});

export const clearCalendarEventsBatch = defineMutation({
  args: { userId: v.string(), googleCalendarId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    if (!(await liveLegacyState(ctx, args.userId))) return false;
    const rows = await ctx.db
      .query("events")
      .withIndex("by_user_and_calendar_and_end", (q) =>
        q.eq("userId", args.userId).eq("calendarId", args.googleCalendarId),
      )
      .take(BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length === BATCH_SIZE;
  },
});

export const beginCalendarFullResync = defineMutation({
  args: { userId: v.string(), googleCalendarId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const state = await liveLegacyState(ctx, args.userId);
    if (!state?.syncAttemptId) throw new Error("Legacy sync lease is unavailable");
    const row = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q.eq("userId", args.userId).eq("googleCalendarId", args.googleCalendarId),
      )
      .unique();
    if (!row) throw new Error("Legacy calendar is unavailable");
    const generation = (row.syncGeneration ?? 0) + 1;
    await ctx.db.patch(row._id, {
      syncGeneration: generation,
      syncGenerationAttemptId: state.syncAttemptId,
    });
    return generation;
  },
});

export const upsertEventsPage = defineMutation({
  args: {
    userId: v.string(),
    events: v.array(googleEventValidator),
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    const state = await liveLegacyState(ctx, args.userId);
    if (!state?.syncAttemptId) return null;
    const connectionId = await ensureGoogleConnection(ctx, args.userId);
    for (const event of args.events) {
      const calendar = await ctx.db
        .query("calendars")
        .withIndex("by_user_and_googleCalendarId", (q) =>
          q.eq("userId", args.userId).eq("googleCalendarId", event.calendarId),
        )
        .unique();
      if (
        !calendar ||
        (args.syncGeneration !== undefined &&
          (calendar.syncGeneration !== args.syncGeneration ||
            calendar.syncGenerationAttemptId !== state.syncAttemptId))
      ) continue;
      const current = await ctx.db
        .query("events")
        .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
          q
            .eq("userId", args.userId)
            .eq("calendarId", event.calendarId)
            .eq("googleEventId", event.googleEventId),
        )
        .first();
      if (event.status === "cancelled") {
        if (current && args.syncGeneration === undefined) await ctx.db.delete(current._id);
        continue;
      }
      const value = {
        userId: args.userId,
        ...event,
        syncGeneration: args.syncGeneration,
        connectionId,
        localCalendarId: calendar._id,
        providerEventId: event.googleEventId,
        providerUpdatedMs: event.googleUpdatedMs,
        providerSeriesId: event.recurringEventId,
        color: event.colorId,
        busy:
          event.transparency === undefined
            ? undefined
            : event.transparency !== "transparent",
      };
      if (current) await ctx.db.replace(current._id, value);
      else await ctx.db.insert("events", value);
      for (const attendee of event.attendees ?? []) {
        if (!attendee.self) {
          await upsertPerson(
            ctx,
            args.userId,
            "attendee",
            attendee.email,
            attendee.displayName,
          );
        }
      }
    }
    return null;
  },
});

export const sweepStaleCalendarEventsBatch = defineMutation({
  args: {
    userId: v.string(),
    googleCalendarId: v.string(),
    keepGeneration: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<{ cursor: string | null; done: boolean }> => {
    const state = await liveLegacyState(ctx, args.userId);
    const calendar = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q.eq("userId", args.userId).eq("googleCalendarId", args.googleCalendarId),
      )
      .unique();
    if (
      !state?.syncAttemptId ||
      calendar?.syncGeneration !== args.keepGeneration ||
      calendar.syncGenerationAttemptId !== state.syncAttemptId
    ) throw new Error("Legacy generation reservation was lost");
    const page = await ctx.db
      .query("events")
      .withIndex("by_user_and_calendar_and_end", (q) =>
        q.eq("userId", args.userId).eq("calendarId", args.googleCalendarId),
      )
      .paginate({ cursor: args.cursor, numItems: BATCH_SIZE });
    for (const row of page.page) {
      if (row.syncGeneration !== args.keepGeneration) await ctx.db.delete(row._id);
    }
    return { cursor: page.continueCursor, done: page.isDone };
  },
});

export const commitCalendarFullResync = defineMutation({
  args: {
    userId: v.string(),
    googleCalendarId: v.string(),
    syncGeneration: v.number(),
    syncToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const state = await liveLegacyState(ctx, args.userId);
    const row = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q.eq("userId", args.userId).eq("googleCalendarId", args.googleCalendarId),
      )
      .unique();
    if (
      row &&
      state?.syncAttemptId &&
      row.syncGeneration === args.syncGeneration &&
      row.syncGenerationAttemptId === state.syncAttemptId
    ) {
      await ctx.db.patch(row._id, {
        syncGenerationAttemptId: undefined,
        syncToken: args.syncToken,
        syncCursor: args.syncToken,
        lastSyncAt: Date.now(),
      });
    }
    return null;
  },
});

export const setCalendarSyncToken = defineMutation({
  args: {
    userId: v.string(),
    googleCalendarId: v.string(),
    syncToken: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    if (!(await liveLegacyState(ctx, args.userId))) return null;
    const row = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q.eq("userId", args.userId).eq("googleCalendarId", args.googleCalendarId),
      )
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        syncToken: args.syncToken,
        syncCursor: args.syncToken,
        lastSyncAt: Date.now(),
      });
    }
    return null;
  },
});

async function compatShared(ctx: MutationCtx, googleCalendarId: string) {
  const row = await ctx.db
    .query("sharedCalendars")
    .withIndex("by_googleCalendarId", (q) => q.eq("googleCalendarId", googleCalendarId))
    .first();
  return row?.syncAttemptId?.startsWith(LEGACY_SHARED_ATTEMPT) &&
    (row.syncLeaseExpiresAt ?? 0) > Date.now()
    ? row
    : null;
}

export const claimSharedCalendarSync = defineMutation({
  args: { googleCalendarId: v.string(), refreshIntervalMs: v.number() },
  returns: v.object({ claimed: v.boolean(), syncToken: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db
      .query("sharedCalendars")
      .withIndex("by_googleCalendarId", (q) =>
        q.eq("googleCalendarId", args.googleCalendarId),
      )
      .first();
    const live = row?.syncAttemptId && (row.syncLeaseExpiresAt ?? 0) > now;
    const fresh = row?.lastSyncAt !== undefined && now - row.lastSyncAt < args.refreshIntervalMs;
    if (live || fresh) return { claimed: false, syncToken: row?.syncToken };
    const patch = {
      provider: "google" as const,
      providerCalendarId: args.googleCalendarId,
      syncAttemptId: `${LEGACY_SHARED_ATTEMPT}${crypto.randomUUID()}`,
      syncLeaseExpiresAt: now + SHARED_LEASE_MS,
    };
    if (row) await ctx.db.patch(row._id, patch);
    else {
      await ctx.db.insert("sharedCalendars", {
        googleCalendarId: args.googleCalendarId,
        ...patch,
      });
    }
    return { claimed: true, syncToken: row?.syncToken };
  },
});

export const releaseSharedCalendarLease = defineMutation({
  args: { googleCalendarId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await compatShared(ctx, args.googleCalendarId);
    if (row) {
      await ctx.db.patch(row._id, {
        syncAttemptId: undefined,
        syncLeaseExpiresAt: undefined,
      });
    }
    return null;
  },
});

export const clearSharedCalendarEventsBatch = defineMutation({
  args: { googleCalendarId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await compatShared(ctx, args.googleCalendarId);
    if (!row?.syncAttemptId) return false;
    if (row.syncGenerationAttemptId !== row.syncAttemptId) {
      await ctx.db.patch(row._id, {
        syncGeneration: (row.syncGeneration ?? 0) + 1,
        syncGenerationAttemptId: row.syncAttemptId,
      });
    }
    // The old action loops while true. Snapshot replacement now happens from
    // setSharedCalendarSynced after every page is durable, so never clear first.
    return false;
  },
});

export const upsertSharedEventsPage = defineMutation({
  args: { events: v.array(googleEventValidator) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    for (const event of args.events) {
      const shared = await compatShared(ctx, event.calendarId);
      if (!shared) continue;
      const current = await ctx.db
        .query("sharedEvents")
        .withIndex("by_calendar_and_googleEventId", (q) =>
          q.eq("calendarId", event.calendarId).eq("googleEventId", event.googleEventId),
        )
        .first();
      if (event.status === "cancelled") {
        if (
          current &&
          shared.syncGenerationAttemptId !== shared.syncAttemptId
        ) await ctx.db.delete(current._id);
        continue;
      }
      const value = {
        ...event,
        provider: "google" as const,
        providerCalendarId: event.calendarId,
        providerEventId: event.googleEventId,
        providerUpdatedMs: event.googleUpdatedMs,
        providerSeriesId: event.recurringEventId,
        color: event.colorId,
        busy:
          event.transparency === undefined
            ? undefined
            : event.transparency !== "transparent",
        syncGeneration: shared.syncGeneration,
      };
      if (current) await ctx.db.replace(current._id, value);
      else await ctx.db.insert("sharedEvents", value);
    }
    return null;
  },
});

export const setSharedCalendarSynced = defineMutation({
  args: { googleCalendarId: v.string(), syncToken: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await compatShared(ctx, args.googleCalendarId);
    if (row) {
      if (
        row.syncAttemptId &&
        row.syncGenerationAttemptId === row.syncAttemptId &&
        row.syncGeneration !== undefined
      ) {
        await ctx.scheduler.runAfter(
          0,
          internal.calendarSync.finishLegacySharedFullResync,
          {
            googleCalendarId: args.googleCalendarId,
            attemptId: row.syncAttemptId,
            keepGeneration: row.syncGeneration,
            syncToken: args.syncToken,
            cursor: null,
          },
        );
      } else {
        await ctx.db.patch(row._id, {
          syncToken: args.syncToken ?? row.syncToken,
          syncCursor: args.syncToken ?? row.syncToken,
          lastSyncAt: Date.now(),
          syncAttemptId: undefined,
          syncLeaseExpiresAt: undefined,
        });
      }
    }
    return null;
  },
});

export const finishLegacySharedFullResync = defineMutation({
  args: {
    googleCalendarId: v.string(),
    attemptId: v.string(),
    keepGeneration: v.number(),
    syncToken: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("sharedCalendars")
      .withIndex("by_googleCalendarId", (q) =>
        q.eq("googleCalendarId", args.googleCalendarId),
      )
      .first();
    if (
      row?.syncAttemptId !== args.attemptId ||
      row.syncGeneration !== args.keepGeneration ||
      row.syncGenerationAttemptId !== args.attemptId
    ) return null;
    const page = await ctx.db
      .query("sharedEvents")
      .withIndex("by_calendar_and_googleEventId", (q) =>
        q.eq("calendarId", args.googleCalendarId),
      )
      .paginate({ cursor: args.cursor, numItems: BATCH_SIZE });
    for (const event of page.page) {
      if (event.syncGeneration !== args.keepGeneration) {
        await ctx.db.delete(event._id);
      }
    }
    if (!page.isDone) {
      await ctx.db.patch(row._id, {
        syncLeaseExpiresAt: Date.now() + SHARED_LEASE_MS,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.calendarSync.finishLegacySharedFullResync,
        { ...args, cursor: page.continueCursor },
      );
      return null;
    }
    await ctx.db.patch(row._id, {
      syncToken: args.syncToken ?? row.syncToken,
      syncCursor: args.syncToken ?? row.syncToken,
      lastSyncAt: Date.now(),
      syncGenerationAttemptId: undefined,
      syncAttemptId: undefined,
      syncLeaseExpiresAt: undefined,
    });
    return null;
  },
});

async function reserveContactGeneration(
  ctx: MutationCtx,
  userId: string,
  feeder: "connection" | "other",
) {
  const legacy = await liveLegacyState(ctx, userId);
  if (!legacy?.syncAttemptId) throw new Error("Legacy sync lease is unavailable");
  const neutral = await googleState(ctx, userId);
  if (!neutral) throw new Error("Google connection sync state is unavailable");
  const generation =
    ((feeder === "connection"
      ? neutral.state.contactsGeneration
      : neutral.state.otherContactsGeneration) ?? 0) + 1;
  await ctx.db.patch(
    neutral.state._id,
    feeder === "connection"
      ? {
          contactsGeneration: generation,
          contactsGenerationAttemptId: legacy.syncAttemptId,
        }
      : {
          otherContactsGeneration: generation,
          otherContactsGenerationAttemptId: legacy.syncAttemptId,
        },
  );
  await ctx.db.patch(
    legacy._id,
    feeder === "connection"
      ? { contactsSyncGeneration: generation }
      : { otherContactsSyncGeneration: generation },
  );
  return { ...neutral, attemptId: legacy.syncAttemptId, generation };
}

export const beginContactsFullResync = defineMutation({
  args: {
    userId: v.string(),
    feeder: v.union(v.literal("connection"), v.literal("other")),
  },
  handler: async (ctx, args): Promise<number> =>
    (await reserveContactGeneration(ctx, args.userId, args.feeder)).generation,
});

async function contactFence(
  ctx: MutationCtx,
  userId: string,
  feeder: "connection" | "other",
  generation?: number,
) {
  const legacy = await liveLegacyState(ctx, userId);
  const neutral = await googleState(ctx, userId);
  if (!legacy?.syncAttemptId || !neutral) return null;
  if (
    generation !== undefined &&
    (feeder === "connection"
      ? neutral.state.contactsGeneration !== generation ||
        neutral.state.contactsGenerationAttemptId !== legacy.syncAttemptId
      : neutral.state.otherContactsGeneration !== generation ||
        neutral.state.otherContactsGenerationAttemptId !== legacy.syncAttemptId)
  ) return null;
  return { ...neutral, attemptId: legacy.syncAttemptId };
}

async function upsertContactPage(
  ctx: MutationCtx,
  userId: string,
  feeder: "connection" | "other",
  contacts: Infer<typeof contactValidator>[],
  generation?: number,
) {
  const fence = await contactFence(ctx, userId, feeder, generation);
  if (!fence) return;
  const source = feeder === "connection" ? "connection" : "other";
  for (const contact of contacts) {
    const saved = feeder === "connection"
      ? await ctx.db
          .query("contacts")
          .withIndex("by_user_and_resourceName", (q) =>
            q.eq("userId", userId).eq("resourceName", contact.resourceName),
          )
          .first()
      : null;
    const other = feeder === "other"
      ? await ctx.db
          .query("otherContactSources")
          .withIndex("by_connection_and_providerContactId", (q) =>
            q
              .eq("connectionId", fence.connectionId)
              .eq("providerContactId", contact.resourceName),
          )
          .unique()
      : null;
    const current = saved ?? other;
    if (contact.deleted) {
      for (const email of current?.emails ?? contact.emails) {
        await releaseSource(
          ctx,
          userId,
          fence.connectionId,
          source,
          contact.resourceName,
          email,
        );
      }
      if (current) await ctx.db.delete(current._id);
      continue;
    }
    const emails = contact.emails.map((email) => email.trim().toLowerCase());
    for (const email of emails) {
      await claimSource(
        ctx,
        userId,
        fence.connectionId,
        source,
        contact.resourceName,
        email,
        generation,
      );
      await upsertPerson(
        ctx,
        userId,
        source,
        email,
        contact.displayName,
        contact.photoUrl,
        generation,
      );
    }
    if (feeder === "connection") {
      const value = {
        userId,
        resourceName: contact.resourceName,
        displayName: contact.displayName,
        emails,
        phones: contact.phones,
        photoUrl: contact.photoUrl,
        googleEtag: contact.googleEtag,
        syncGeneration: generation ?? saved?.syncGeneration,
        connectionId: fence.connectionId,
        providerContactId: contact.resourceName,
        providerVersion: contact.googleEtag,
      };
      if (saved) await ctx.db.replace(saved._id, value);
      else await ctx.db.insert("contacts", value);
    } else {
      const value = {
        userId,
        connectionId: fence.connectionId,
        providerContactId: contact.resourceName,
        emails,
        syncGeneration: generation ?? other?.syncGeneration,
      };
      if (other) await ctx.db.replace(other._id, value);
      else await ctx.db.insert("otherContactSources", value);
    }
  }
}

export const upsertContactsPage = defineMutation({
  args: {
    userId: v.string(),
    contacts: v.array(contactValidator),
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    await upsertContactPage(
      ctx,
      args.userId,
      "connection",
      args.contacts,
      args.syncGeneration,
    );
    return null;
  },
});

export const upsertOtherContactsPage = defineMutation({
  args: {
    userId: v.string(),
    contacts: v.array(contactValidator),
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    await upsertContactPage(
      ctx,
      args.userId,
      "other",
      args.contacts,
      args.syncGeneration,
    );
    return null;
  },
});

export const sweepStaleContactsBatch = defineMutation({
  args: {
    userId: v.string(),
    keepGeneration: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<{ cursor: string | null; done: boolean }> => {
    const fence = await contactFence(ctx, args.userId, "connection", args.keepGeneration);
    if (!fence) throw new Error("Legacy contact generation reservation was lost");
    const page = await ctx.db
      .query("contacts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: BATCH_SIZE });
    for (const row of page.page) {
      if (row.syncGeneration === args.keepGeneration) continue;
      for (const email of row.emails) {
        await releaseSource(
          ctx,
          args.userId,
          fence.connectionId,
          "connection",
          row.providerContactId ?? row.resourceName,
          email,
        );
      }
      await ctx.db.delete(row._id);
    }
    return { cursor: page.continueCursor, done: page.isDone };
  },
});

export const sweepStaleOtherPeopleBatch = defineMutation({
  args: {
    userId: v.string(),
    keepGeneration: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<{ cursor: string | null; done: boolean }> => {
    const fence = await contactFence(ctx, args.userId, "other", args.keepGeneration);
    if (!fence) throw new Error("Legacy Other Contacts reservation was lost");
    const page = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: BATCH_SIZE });
    for (const person of page.page) {
      if (
        !person.sources.includes("other") ||
        person.otherSyncGeneration === args.keepGeneration
      ) continue;
      const claims = await ctx.db
        .query("personSourceClaims")
        .withIndex("by_user_and_email_and_source", (q) =>
          q.eq("userId", args.userId).eq("email", person.email).eq("source", "other"),
        )
        .collect();
      for (const claim of claims) await ctx.db.delete(claim._id);
      const sources = person.sources.filter((source) => source !== "other");
      if (sources.length === 0) await ctx.db.delete(person._id);
      else await ctx.db.patch(person._id, { sources, updatedAt: Date.now() });
    }
    return { cursor: page.continueCursor, done: page.isDone };
  },
});

async function setContactSync(
  ctx: MutationCtx,
  userId: string,
  feeder: "connection" | "other",
  syncToken?: string,
  syncGeneration?: number,
) {
  const fence = await contactFence(ctx, userId, feeder, syncGeneration);
  if (!fence) return;
  const now = Date.now();
  const legacy = await ctx.db
    .query("syncState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (!legacy) return;
  if (feeder === "connection") {
    await ctx.db.patch(legacy._id, {
      contactsSyncToken: syncToken,
      contactsSyncGeneration: syncGeneration ?? legacy.contactsSyncGeneration,
      lastContactsSyncAt: now,
    });
    await ctx.db.patch(fence.state._id, {
      contactsCursor: syncToken,
      contactsGeneration: syncGeneration ?? fence.state.contactsGeneration,
      contactsGenerationAttemptId:
        syncGeneration === undefined
          ? fence.state.contactsGenerationAttemptId
          : undefined,
      contactsLastSyncedAt: now,
    });
  } else {
    await ctx.db.patch(legacy._id, {
      otherContactsSyncToken: syncToken,
      otherContactsSyncGeneration:
        syncGeneration ?? legacy.otherContactsSyncGeneration,
      lastOtherContactsSyncAt: now,
    });
    await ctx.db.patch(fence.state._id, {
      otherContactsCursor: syncToken,
      otherContactsGeneration:
        syncGeneration ?? fence.state.otherContactsGeneration,
      otherContactsGenerationAttemptId:
        syncGeneration === undefined
          ? fence.state.otherContactsGenerationAttemptId
          : undefined,
      otherContactsBackfillRequired:
        syncGeneration === undefined
          ? fence.state.otherContactsBackfillRequired
          : false,
      otherContactsLastSyncedAt: now,
    });
  }
}

export const setContactsSync = defineMutation({
  args: {
    userId: v.string(),
    syncToken: v.optional(v.string()),
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    await setContactSync(
      ctx,
      args.userId,
      "connection",
      args.syncToken,
      args.syncGeneration,
    );
    return null;
  },
});

export const setOtherContactsSync = defineMutation({
  args: {
    userId: v.string(),
    syncToken: v.optional(v.string()),
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    await setContactSync(
      ctx,
      args.userId,
      "other",
      args.syncToken,
      args.syncGeneration,
    );
    return null;
  },
});

export const listEventsPageForEngagement = defineQuery({
  args: {
    userId: v.string(),
    sinceMs: v.number(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
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
  },
  handler: async (ctx, args): Promise<null> => {
    for (const score of args.scores) {
      const row = await ctx.db
        .query("people")
        .withIndex("by_user_and_email", (q) =>
          q.eq("userId", args.userId).eq("email", score.email),
        )
        .unique();
      if (row) await ctx.db.patch(row._id, { ...score, updatedAt: Date.now() });
    }
    return null;
  },
});

export const enqueueSyncs = defineMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const page = await ctx.db
      .query("syncState")
      .withIndex("by_nextSyncDueAt", (q) => q.lte("nextSyncDueAt", now))
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    for (const row of page.page) {
      await ctx.scheduler.runAfter(0, internal.googleSync.syncUser, {
        userId: row.userId,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.googleSync.enqueueSyncs, {
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

export const enqueueEngagementRefresh = defineMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("syncState")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    for (const row of page.page) {
      await ctx.scheduler.runAfter(0, internal.googleSync.recomputeEngagement, {
        userId: row.userId,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.googleSync.enqueueEngagementRefresh,
        { cursor: page.continueCursor },
      );
    }
    return null;
  },
});
