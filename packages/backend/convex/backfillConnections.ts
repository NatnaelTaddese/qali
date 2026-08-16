/**
 * Resumable expand/backfill for the provider-neutral connection model. Legacy
 * fields remain authoritative; every neutral field is repaired from them.
 *
 *   npx convex run backfillConnections:enqueueConnectionBackfill '{}'
 *
 * Each invocation creates a run id. Discovery walks every table that can prove a
 * user exists, while connectionBackfillUsers deduplicates users within that run.
 * Child tables are cursor-paginated, so a restart is safe at every boundary.
 */

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  connectionSyncFields,
  ensureGoogleConnection,
} from "./domains/calendar/connections";

const DISCOVERY_BATCH = 100;
const ROW_BATCH = 100;
const VERIFY_BATCH_MAX = 100;

const discoveryPhaseValidator = v.union(
  v.literal("syncState"),
  v.literal("calendars"),
  v.literal("events"),
  v.literal("recurringSeries"),
  v.literal("bookingPages"),
  v.literal("bookings"),
  v.literal("contacts"),
  v.literal("people"),
  v.literal("calendarConnections"),
);
type DiscoveryPhase =
  | "syncState"
  | "calendars"
  | "events"
  | "recurringSeries"
  | "bookingPages"
  | "bookings"
  | "contacts"
  | "people"
  | "calendarConnections";
const DISCOVERY_PHASES: DiscoveryPhase[] = [
  "syncState",
  "calendars",
  "events",
  "recurringSeries",
  "bookingPages",
  "bookings",
  "contacts",
  "people",
  "calendarConnections",
];

const userPhaseValidator = v.union(
  v.literal("calendars"),
  v.literal("events"),
  v.literal("recurringSeries"),
  v.literal("bookingPages"),
  v.literal("bookings"),
  v.literal("contacts"),
  v.literal("people"),
);
type UserPhase =
  | "calendars"
  | "events"
  | "recurringSeries"
  | "bookingPages"
  | "bookings"
  | "contacts"
  | "people";
const USER_PHASES: UserPhase[] = [
  "calendars",
  "events",
  "recurringSeries",
  "bookingPages",
  "bookings",
  "contacts",
  "people",
];

type DiscoveryPage = {
  userIds: string[];
  isDone: boolean;
  continueCursor: string;
};

async function discoverUsersPage(
  ctx: MutationCtx,
  phase: DiscoveryPhase,
  cursor: string | null,
): Promise<DiscoveryPage> {
  if (phase === "syncState") {
    const page = await ctx.db
      .query("syncState")
      .paginate({ cursor, numItems: DISCOVERY_BATCH });
    return { ...page, userIds: page.page.map((r) => r.userId) };
  }
  if (phase === "calendars") {
    const page = await ctx.db
      .query("calendars")
      .paginate({ cursor, numItems: DISCOVERY_BATCH });
    return { ...page, userIds: page.page.map((r) => r.userId) };
  }
  if (phase === "events") {
    const page = await ctx.db
      .query("events")
      .paginate({ cursor, numItems: DISCOVERY_BATCH });
    return { ...page, userIds: page.page.map((r) => r.userId) };
  }
  if (phase === "recurringSeries") {
    const page = await ctx.db
      .query("recurringSeries")
      .paginate({ cursor, numItems: DISCOVERY_BATCH });
    return { ...page, userIds: page.page.map((r) => r.userId) };
  }
  if (phase === "bookingPages") {
    const page = await ctx.db
      .query("bookingPages")
      .paginate({ cursor, numItems: DISCOVERY_BATCH });
    return { ...page, userIds: page.page.map((r) => r.userId) };
  }
  if (phase === "bookings") {
    const page = await ctx.db
      .query("bookings")
      .paginate({ cursor, numItems: DISCOVERY_BATCH });
    return { ...page, userIds: page.page.map((r) => r.hostUserId) };
  }
  if (phase === "contacts") {
    const page = await ctx.db
      .query("contacts")
      .paginate({ cursor, numItems: DISCOVERY_BATCH });
    return { ...page, userIds: page.page.map((r) => r.userId) };
  }
  if (phase === "people") {
    const page = await ctx.db
      .query("people")
      .paginate({ cursor, numItems: DISCOVERY_BATCH });
    return { ...page, userIds: page.page.map((r) => r.userId) };
  }
  const page = await ctx.db
    .query("calendarConnections")
    .paginate({ cursor, numItems: DISCOVERY_BATCH });
  return { ...page, userIds: page.page.map((r) => r.userId) };
}

export const enqueueConnectionBackfill = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    phase: v.optional(discoveryPhaseValidator),
    runId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const runId = args.runId ?? crypto.randomUUID();
    const phase = args.phase ?? DISCOVERY_PHASES[0];
    const page = await discoverUsersPage(ctx, phase, args.cursor ?? null);

    for (const userId of new Set(page.userIds)) {
      const progress = await ctx.db
        .query("connectionBackfillUsers")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      if (progress?.runId === runId) continue;
      const now = Date.now();
      if (progress) {
        await ctx.db.patch(progress._id, {
          runId,
          updatedAt: now,
          completedAt: undefined,
        });
      } else {
        await ctx.db.insert("connectionBackfillUsers", {
          userId,
          runId,
          updatedAt: now,
        });
      }
      await ctx.scheduler.runAfter(0, internal.backfillConnections.backfillUser, {
        userId,
        runId,
      });
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.enqueueConnectionBackfill,
        { phase, cursor: page.continueCursor, runId },
      );
      return null;
    }
    const next = DISCOVERY_PHASES[DISCOVERY_PHASES.indexOf(phase) + 1];
    if (next) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.enqueueConnectionBackfill,
        { phase: next, cursor: null, runId },
      );
    } else {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.backfillSharedRecords,
        { phase: "calendars", cursor: null },
      );
    }
    return null;
  },
});

async function repairConnectionSyncState(
  ctx: MutationCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
): Promise<void> {
  const legacy = await ctx.db
    .query("syncState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const row = await ctx.db
    .query("connectionSyncState")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .unique();
  const fields = connectionSyncFields(legacy);
  if (row) {
    // A backfill read can be stale relative to a heartbeat. Never copy a legacy
    // lease over an operational neutral attempt; the transaction retry also
    // protects a heartbeat that races this check.
    if (row.syncAttemptId && (row.syncLeaseExpiresAt ?? 0) > Date.now()) return;
    const forceOtherFullSync =
      row.otherContactsBackfillRequired !== false &&
      (row.otherContactsBackfillRequired === true ||
        legacy?.otherContactsSyncToken !== undefined ||
        legacy?.otherContactsSyncGeneration !== undefined ||
        legacy?.lastOtherContactsSyncAt !== undefined);
    const patch = {
      userId,
      contactsCursor: row.contactsCursor ?? fields.contactsCursor,
      otherContactsCursor: forceOtherFullSync
        ? undefined
        : row.otherContactsCursor ?? fields.otherContactsCursor,
      contactsLastSyncedAt:
        row.contactsLastSyncedAt ?? fields.contactsLastSyncedAt,
      otherContactsLastSyncedAt:
        row.otherContactsLastSyncedAt ?? fields.otherContactsLastSyncedAt,
      contactsGeneration: row.contactsGeneration ?? fields.contactsGeneration,
      otherContactsGeneration:
        row.otherContactsGeneration ?? fields.otherContactsGeneration,
      nextSyncDueAt: row.nextSyncDueAt ?? fields.nextSyncDueAt,
      syncIntervalMs: row.syncIntervalMs ?? fields.syncIntervalMs,
      otherContactsBackfillRequired: forceOtherFullSync
        ? true
        : row.otherContactsBackfillRequired,
    };
    await ctx.db.patch(row._id, patch);
    if (forceOtherFullSync && legacy?.otherContactsSyncToken !== undefined) {
      await ctx.db.patch(legacy._id, { otherContactsSyncToken: undefined });
    }
  } else {
    await ctx.db.insert("connectionSyncState", {
      connectionId,
      userId,
      ...fields,
    });
  }
  const userState = await ctx.db
    .query("userSyncState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (!userState) {
    await ctx.db.insert("userSyncState", {
      userId,
      engagementDirty: false,
      updatedAt: Date.now(),
    });
  }
}

async function localCalendar(
  ctx: MutationCtx | QueryCtx,
  userId: string,
  providerCalendarId: string,
) {
  return await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (q) =>
      q.eq("userId", userId).eq("googleCalendarId", providerCalendarId),
    )
    .unique();
}

async function primaryCalendar(ctx: MutationCtx | QueryCtx, userId: string) {
  return (
    await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("primary"), true))
      .take(1)
  )[0];
}

export const backfillUser = internalMutation({
  args: { userId: v.string(), runId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<null> => {
    const connectionId = await ensureGoogleConnection(ctx, args.userId);
    await repairConnectionSyncState(ctx, args.userId, connectionId);
    const page = await processUserPage(ctx, {
      userId: args.userId,
      connectionId,
      phase: "calendars",
      cursor: null,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.backfillConnections.backfillUserRows,
      {
        userId: args.userId,
        connectionId,
        phase: page.isDone ? "events" : "calendars",
        cursor: page.isDone ? null : page.continueCursor,
        runId: args.runId,
      },
    );
    return null;
  },
});

function operationStatusForBooking(
  booking: Doc<"bookings">,
): Doc<"calendarOperations">["status"] {
  if (booking.status === "accepted") return "succeeded";
  if (booking.acceptAttemptId) return "pending";
  return booking.acceptMayHaveSucceeded === true ? "ambiguous" : "failed";
}

async function repairBookingOperation(
  ctx: MutationCtx,
  booking: Doc<"bookings">,
  connectionId: Id<"calendarConnections">,
  localCalendarId: Id<"calendars"> | undefined,
): Promise<void> {
  if (!booking.acceptOperationId) return;
  const existing = await ctx.db
    .query("calendarOperations")
    .withIndex("by_connection_and_key", (q) =>
      q
        .eq("connectionId", connectionId)
        .eq("idempotencyKey", booking.acceptOperationId!),
    )
    .unique();
  const now = Date.now();
  const value = {
    userId: booking.hostUserId,
    kind: "create" as const,
    status: operationStatusForBooking(booking),
    bookingId: booking._id,
    attemptId: booking.acceptAttemptId,
    leaseExpiresAt: booking.acceptLeaseExpiresAt,
    mayHaveSucceeded: booking.acceptMayHaveSucceeded,
    localCalendarId,
    providerCalendarId: booking.calendarId,
    providerEventId: booking.googleEventId,
    updatedAt: now,
  };
  if (existing) await ctx.db.patch(existing._id, value);
  else {
    await ctx.db.insert("calendarOperations", {
      connectionId,
      idempotencyKey: booking.acceptOperationId,
      createdAt: now,
      ...value,
    });
  }
}

type ProcessedPage = { isDone: boolean; continueCursor: string };

async function backfillContactClaim(
  ctx: MutationCtx,
  contact: Doc<"contacts">,
  connectionId: Id<"calendarConnections">,
  emailValue: string,
): Promise<void> {
  const email = emailValue.trim().toLowerCase();
  if (!email) return;
  const providerContactId = contact.providerContactId ?? contact.resourceName;
  const candidates = await ctx.db
    .query("personSourceClaims")
    .withIndex("by_connection_and_source_and_email", (q) =>
      q
        .eq("connectionId", connectionId)
        .eq("source", "connection")
        .eq("email", email),
    )
    .collect();
  const exact =
    candidates.find((claim) => claim.providerContactId === providerContactId) ??
    candidates.find((claim) => claim.providerContactId === undefined);
  const value = {
    userId: contact.userId,
    connectionId,
    source: "connection" as const,
    providerContactId,
    email,
    syncGeneration: contact.syncGeneration,
    updatedAt: Date.now(),
  };
  if (exact) await ctx.db.patch(exact._id, value);
  else await ctx.db.insert("personSourceClaims", value);
}

async function processUserPage(
  ctx: MutationCtx,
  args: {
    userId: string;
    connectionId: Id<"calendarConnections">;
    phase: UserPhase;
    cursor: string | null;
  },
): Promise<ProcessedPage> {
  if (args.phase === "calendars") {
    const page = await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: ROW_BATCH });
    for (const row of page.page) {
      await ctx.db.patch(row._id, {
        connectionId: args.connectionId,
        providerCalendarId: row.googleCalendarId,
        syncCursor: row.syncToken,
      });
    }
    return page;
  }
  if (args.phase === "events") {
    const page = await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: ROW_BATCH });
    for (const row of page.page) {
      const calendar = await localCalendar(ctx, args.userId, row.calendarId);
      await ctx.db.patch(row._id, {
        connectionId: args.connectionId,
        localCalendarId: calendar?._id,
        providerEventId: row.googleEventId,
        providerUpdatedMs: row.googleUpdatedMs,
        providerSeriesId: row.recurringEventId,
        color: row.colorId,
        busy:
          row.transparency === undefined
            ? undefined
            : row.transparency !== "transparent",
      });
    }
    return page;
  }
  if (args.phase === "recurringSeries") {
    const page = await ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
        q.eq("userId", args.userId),
      )
      .paginate({ cursor: args.cursor, numItems: ROW_BATCH });
    for (const row of page.page) {
      const calendar = await localCalendar(ctx, args.userId, row.calendarId);
      await ctx.db.patch(row._id, {
        connectionId: args.connectionId,
        localCalendarId: calendar?._id,
        providerEventId: row.googleEventId,
        providerSeriesId: row.googleEventId,
        providerUpdatedMs: row.sourceUpdatedMs,
      });
    }
    return page;
  }
  if (args.phase === "bookingPages") {
    const page = await ctx.db
      .query("bookingPages")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: ROW_BATCH });
    const primary = await primaryCalendar(ctx, args.userId);
    for (const row of page.page) {
      await ctx.db.patch(row._id, {
        targetConnectionId: args.connectionId,
        targetCalendarId: primary?._id,
      });
    }
    return page;
  }
  if (args.phase === "bookings") {
    const page = await ctx.db
      .query("bookings")
      .withIndex("by_host_and_start", (q) => q.eq("hostUserId", args.userId))
      .paginate({ cursor: args.cursor, numItems: ROW_BATCH });
    const pageTarget = await ctx.db
      .query("bookingPages")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    const primary = pageTarget?.targetCalendarId
      ? await ctx.db.get(pageTarget.targetCalendarId)
      : await primaryCalendar(ctx, args.userId);
    for (const row of page.page) {
      const calendar = row.calendarId
        ? await localCalendar(ctx, args.userId, row.calendarId)
        : primary;
      await ctx.db.patch(row._id, {
        connectionId: args.connectionId,
        providerEventId: row.googleEventId,
        targetConnectionId: args.connectionId,
        targetCalendarId: calendar?._id,
      });
      await repairBookingOperation(
        ctx,
        row,
        args.connectionId,
        calendar?._id,
      );
    }
    return page;
  }
  if (args.phase === "people") {
    const page = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: ROW_BATCH });
    let missingOtherMaterialization = false;
    for (const person of page.page) {
      if (!person.sources.includes("other")) continue;
      const claims = await ctx.db
        .query("personSourceClaims")
        .withIndex("by_user_and_email_and_source", (q) =>
          q
            .eq("userId", args.userId)
            .eq("email", person.email)
            .eq("source", "other"),
        )
        .collect();
      let materialized = false;
      for (const claim of claims) {
        if (!claim.providerContactId) continue;
        const source = await ctx.db
          .query("otherContactSources")
          .withIndex("by_connection_and_providerContactId", (q) =>
            q
              .eq("connectionId", claim.connectionId)
              .eq("providerContactId", claim.providerContactId!),
          )
          .unique();
        if (source?.emails.includes(person.email)) {
          materialized = true;
          break;
        }
      }
      if (!materialized) missingOtherMaterialization = true;
    }
    if (missingOtherMaterialization) {
      const state = await ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
        .unique();
      const live =
        state?.syncAttemptId && (state.syncLeaseExpiresAt ?? 0) > Date.now();
      if (state && !live) {
        await ctx.db.patch(state._id, {
          otherContactsCursor: undefined,
          otherContactsBackfillRequired: true,
        });
        const legacy = await ctx.db
          .query("syncState")
          .withIndex("by_user", (q) => q.eq("userId", args.userId))
          .unique();
        if (legacy) {
          await ctx.db.patch(legacy._id, { otherContactsSyncToken: undefined });
        }
      }
    }
    return page;
  }
  const page = await ctx.db
    .query("contacts")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .paginate({ cursor: args.cursor, numItems: ROW_BATCH });
  for (const row of page.page) {
    await ctx.db.patch(row._id, {
      connectionId: args.connectionId,
      providerContactId: row.resourceName,
      providerVersion: row.googleEtag,
    });
    for (const email of row.emails) {
      await backfillContactClaim(ctx, row, args.connectionId, email);
      const normalized = email.trim().toLowerCase();
      if (!normalized) continue;
      const person = await ctx.db
        .query("people")
        .withIndex("by_user_and_email", (q) =>
          q.eq("userId", args.userId).eq("email", normalized),
        )
        .unique();
      if (person) {
        await ctx.db.patch(person._id, {
          displayName: row.displayName ?? person.displayName,
          photoUrl: row.photoUrl ?? person.photoUrl,
          sources: person.sources.includes("connection")
            ? person.sources
            : [...person.sources, "connection"],
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.insert("people", {
          userId: args.userId,
          email: normalized,
          displayName: row.displayName,
          photoUrl: row.photoUrl,
          sources: ["connection"],
          updatedAt: Date.now(),
        });
      }
    }
  }
  return page;
}

export const backfillUserRows = internalMutation({
  args: {
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    phase: userPhaseValidator,
    cursor: v.union(v.string(), v.null()),
    runId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const page = await processUserPage(ctx, args);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.backfillUserRows,
        { ...args, cursor: page.continueCursor },
      );
      return null;
    }
    const next = USER_PHASES[USER_PHASES.indexOf(args.phase) + 1];
    if (next) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.backfillUserRows,
        { ...args, phase: next, cursor: null },
      );
    } else if (args.runId) {
      const progress = await ctx.db
        .query("connectionBackfillUsers")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .unique();
      if (progress?.runId === args.runId) {
        await ctx.db.patch(progress._id, {
          completedAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
    return null;
  },
});

/** Compatibility entry point retained for already scheduled/manual event passes. */
export const backfillUserEvents = internalMutation({
  args: {
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    const page = await processUserPage(ctx, { ...args, phase: "events" });
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.backfillUserEvents,
        { ...args, cursor: page.continueCursor },
      );
    } else {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.backfillUserTail,
        { userId: args.userId, connectionId: args.connectionId },
      );
    }
    return null;
  },
});

/** Compatibility entry point retained for the old tail handoff. */
export const backfillUserTail = internalMutation({
  args: { userId: v.string(), connectionId: v.id("calendarConnections") },
  handler: async (ctx, args): Promise<null> => {
    const bookings = await processUserPage(ctx, {
      ...args,
      phase: "bookings",
      cursor: null,
    });
    if (!bookings.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.backfillUserRows,
        { ...args, phase: "bookings", cursor: bookings.continueCursor },
      );
    } else {
      // Old scheduled tail calls still seed booking operations immediately. The
      // new cursor pipeline then repairs series and the remaining phases.
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.backfillUserRows,
        { ...args, phase: "recurringSeries", cursor: null },
      );
    }
    return null;
  },
});

export const backfillSharedRecords = internalMutation({
  args: {
    phase: v.union(v.literal("calendars"), v.literal("events")),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    if (args.phase === "calendars") {
      const page = await ctx.db
        .query("sharedCalendars")
        .paginate({ cursor: args.cursor, numItems: ROW_BATCH });
      for (const row of page.page) {
        await ctx.db.patch(row._id, {
          provider: "google",
          providerCalendarId: row.googleCalendarId,
          syncCursor: row.syncToken,
        });
      }
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.backfillSharedRecords,
        page.isDone
          ? { phase: "events", cursor: null }
          : { phase: "calendars", cursor: page.continueCursor },
      );
      return null;
    }
    const page = await ctx.db
      .query("sharedEvents")
      .paginate({ cursor: args.cursor, numItems: ROW_BATCH });
    for (const row of page.page) {
      await ctx.db.patch(row._id, {
        provider: "google",
        providerCalendarId: row.calendarId,
        providerEventId: row.googleEventId,
        providerUpdatedMs: row.googleUpdatedMs,
        providerSeriesId: row.recurringEventId,
        color: row.colorId,
        busy:
          row.transparency === undefined
            ? undefined
            : row.transparency !== "transparent",
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillConnections.backfillSharedRecords,
        { phase: "events", cursor: page.continueCursor },
      );
    }
    return null;
  },
});

const verificationPhaseValidator = v.union(
  discoveryPhaseValidator,
  v.literal("connectionSyncState"),
  v.literal("calendarOperations"),
  v.literal("sharedCalendars"),
  v.literal("sharedEvents"),
  v.literal("connectionBackfillUsers"),
);
type VerificationPhase =
  | DiscoveryPhase
  | "connectionSyncState"
  | "calendarOperations"
  | "sharedCalendars"
  | "sharedEvents"
  | "connectionBackfillUsers";

type VerificationMismatch = { id: string; reasons: string[] };
type VerificationPage = {
  phase: VerificationPhase;
  scanned: number;
  mismatches: number;
  examples: VerificationMismatch[];
  isDone: boolean;
  continueCursor: string;
};

function differs(actual: unknown, expected: unknown): boolean {
  return actual !== expected;
}

async function googleConnection(ctx: QueryCtx, userId: string) {
  return await ctx.db
    .query("calendarConnections")
    .withIndex("by_user_and_provider", (q) =>
      q.eq("userId", userId).eq("provider", "google"),
    )
    .take(2);
}

async function verifyPage(
  ctx: QueryCtx,
  phase: VerificationPhase,
  cursor: string | null,
  numItems: number,
): Promise<VerificationPage> {
  const mismatches: VerificationMismatch[] = [];
  const add = (id: string, reasons: string[]) => {
    if (reasons.length) mismatches.push({ id, reasons });
  };
  const finish = (page: {
    page: unknown[];
    isDone: boolean;
    continueCursor: string;
  }): VerificationPage => ({
    phase,
    scanned: page.page.length,
    mismatches: mismatches.length,
    examples: mismatches.slice(0, 20),
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  });

  if (phase === "syncState") {
    const page = await ctx.db.query("syncState").paginate({ cursor, numItems });
    for (const row of page.page) {
      const connections = await googleConnection(ctx, row.userId);
      const reasons: string[] = [];
      if (connections.length !== 1) reasons.push("googleConnectionCount");
      const state = connections[0]
        ? await ctx.db
            .query("connectionSyncState")
            .withIndex("by_connection", (q) =>
              q.eq("connectionId", connections[0]!._id),
            )
            .unique()
        : null;
      const expected = connectionSyncFields(row);
      if (!state) reasons.push("connectionSyncState");
      else {
        for (const [key, value] of Object.entries(expected)) {
          if (differs(state[key as keyof typeof expected], value)) {
            reasons.push(key);
          }
        }
      }
      add(row._id, reasons);
    }
    return finish(page);
  }
  if (phase === "calendarConnections") {
    const page = await ctx.db
      .query("calendarConnections")
      .paginate({ cursor, numItems });
    for (const row of page.page) {
      const state = await ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", row._id))
        .take(2);
      add(row._id, state.length === 1 ? [] : ["connectionSyncStateCount"]);
    }
    return finish(page);
  }
  if (phase === "connectionSyncState") {
    const page = await ctx.db
      .query("connectionSyncState")
      .paginate({ cursor, numItems });
    for (const row of page.page) {
      const connection = await ctx.db.get(row.connectionId);
      const reasons: string[] = [];
      if (!connection || connection.userId !== row.userId) {
        reasons.push("connectionOwner");
      }
      if (row.otherContactsBackfillRequired) {
        reasons.push("otherContactsFullSyncRequired");
      }
      add(row._id, reasons);
    }
    return finish(page);
  }
  if (phase === "calendars") {
    const page = await ctx.db.query("calendars").paginate({ cursor, numItems });
    for (const row of page.page) {
      const connections = await googleConnection(ctx, row.userId);
      const reasons: string[] = [];
      if (row.connectionId !== connections[0]?._id) reasons.push("connectionId");
      if (row.providerCalendarId !== row.googleCalendarId)
        reasons.push("providerCalendarId");
      if (row.syncCursor !== row.syncToken) reasons.push("syncCursor");
      add(row._id, reasons);
    }
    return finish(page);
  }
  if (phase === "events") {
    const page = await ctx.db.query("events").paginate({ cursor, numItems });
    for (const row of page.page) {
      const connections = await googleConnection(ctx, row.userId);
      const calendar = await localCalendar(ctx, row.userId, row.calendarId);
      const reasons: string[] = [];
      if (row.connectionId !== connections[0]?._id) reasons.push("connectionId");
      if (!calendar) reasons.push("localCalendarUnresolved");
      if (row.localCalendarId !== calendar?._id) reasons.push("localCalendarId");
      if (row.providerEventId !== row.googleEventId) reasons.push("providerEventId");
      if (row.providerUpdatedMs !== row.googleUpdatedMs)
        reasons.push("providerUpdatedMs");
      if (row.providerSeriesId !== row.recurringEventId)
        reasons.push("providerSeriesId");
      if (row.color !== row.colorId) reasons.push("color");
      if (
        row.busy !==
        (row.transparency === undefined
          ? undefined
          : row.transparency !== "transparent")
      ) reasons.push("busy");
      add(row._id, reasons);
    }
    return finish(page);
  }
  if (phase === "recurringSeries") {
    const page = await ctx.db
      .query("recurringSeries")
      .paginate({ cursor, numItems });
    for (const row of page.page) {
      const connections = await googleConnection(ctx, row.userId);
      const calendar = await localCalendar(ctx, row.userId, row.calendarId);
      const reasons: string[] = [];
      if (row.connectionId !== connections[0]?._id) reasons.push("connectionId");
      if (!calendar) reasons.push("localCalendarUnresolved");
      if (row.localCalendarId !== calendar?._id) reasons.push("localCalendarId");
      if (row.providerEventId !== row.googleEventId) reasons.push("providerEventId");
      if (row.providerSeriesId !== row.googleEventId)
        reasons.push("providerSeriesId");
      if (row.providerUpdatedMs !== row.sourceUpdatedMs)
        reasons.push("providerUpdatedMs");
      add(row._id, reasons);
    }
    return finish(page);
  }
  if (phase === "bookingPages") {
    const page = await ctx.db
      .query("bookingPages")
      .paginate({ cursor, numItems });
    for (const row of page.page) {
      const connections = await googleConnection(ctx, row.userId);
      const primary = await primaryCalendar(ctx, row.userId);
      const reasons: string[] = [];
      if (row.targetConnectionId !== connections[0]?._id)
        reasons.push("targetConnectionId");
      if (row.targetCalendarId !== primary?._id) reasons.push("targetCalendarId");
      add(row._id, reasons);
    }
    return finish(page);
  }
  if (phase === "bookings") {
    const page = await ctx.db.query("bookings").paginate({ cursor, numItems });
    for (const row of page.page) {
      const connections = await googleConnection(ctx, row.hostUserId);
      const calendar = row.calendarId
        ? await localCalendar(ctx, row.hostUserId, row.calendarId)
        : await primaryCalendar(ctx, row.hostUserId);
      const reasons: string[] = [];
      if (row.connectionId !== connections[0]?._id) reasons.push("connectionId");
      if (row.targetConnectionId !== connections[0]?._id)
        reasons.push("targetConnectionId");
      if (row.calendarId && !calendar) reasons.push("localCalendarUnresolved");
      if (row.targetCalendarId !== calendar?._id) reasons.push("targetCalendarId");
      if (row.providerEventId !== row.googleEventId) reasons.push("providerEventId");
      if (row.acceptOperationId) {
        const operation = connections[0]
          ? await ctx.db
              .query("calendarOperations")
              .withIndex("by_connection_and_key", (q) =>
                q
                  .eq("connectionId", connections[0]!._id)
                  .eq("idempotencyKey", row.acceptOperationId!),
              )
              .first()
          : null;
        if (!operation) reasons.push("calendarOperation");
        else {
          if (operation.bookingId !== row._id) reasons.push("operationBookingId");
          if (operation.status !== operationStatusForBooking(row))
            reasons.push("operationStatus");
          if (operation.attemptId !== row.acceptAttemptId)
            reasons.push("operationAttemptId");
          if (operation.leaseExpiresAt !== row.acceptLeaseExpiresAt)
            reasons.push("operationLeaseExpiresAt");
          if (operation.providerEventId !== row.googleEventId)
            reasons.push("operationProviderEventId");
        }
      }
      add(row._id, reasons);
    }
    return finish(page);
  }
  if (phase === "contacts") {
    const page = await ctx.db.query("contacts").paginate({ cursor, numItems });
    for (const row of page.page) {
      const connections = await googleConnection(ctx, row.userId);
      const reasons: string[] = [];
      if (row.connectionId !== connections[0]?._id) reasons.push("connectionId");
      if (row.providerContactId !== row.resourceName)
        reasons.push("providerContactId");
      if (row.providerVersion !== row.googleEtag) reasons.push("providerVersion");
      if (connections[0]) {
        for (const emailValue of new Set(row.emails)) {
          const email = emailValue.trim().toLowerCase();
          if (!email) continue;
          const claims = await ctx.db
            .query("personSourceClaims")
            .withIndex("by_connection_and_source_and_email", (q) =>
              q
                .eq("connectionId", connections[0]!._id)
                .eq("source", "connection")
                .eq("email", email),
            )
            .collect();
          const exact = claims.filter(
            (claim) => claim.providerContactId === row.resourceName,
          );
          if (exact.length !== 1) reasons.push(`claim:${email}`);
          else if (exact[0]!.syncGeneration !== row.syncGeneration) {
            reasons.push(`claimGeneration:${email}`);
          }
          if (claims.some((claim) => claim.providerContactId === undefined)) {
            reasons.push(`claimIdentity:${email}`);
          }
        }
      }
      add(row._id, reasons);
    }
    return finish(page);
  }
  if (phase === "sharedCalendars") {
    const page = await ctx.db
      .query("sharedCalendars")
      .paginate({ cursor, numItems });
    for (const row of page.page) {
      const reasons: string[] = [];
      if (row.provider !== "google") reasons.push("provider");
      if (row.providerCalendarId !== row.googleCalendarId)
        reasons.push("providerCalendarId");
      if (row.syncCursor !== row.syncToken) reasons.push("syncCursor");
      add(row._id, reasons);
    }
    return finish(page);
  }
  if (phase === "sharedEvents") {
    const page = await ctx.db
      .query("sharedEvents")
      .paginate({ cursor, numItems });
    for (const row of page.page) {
      const reasons: string[] = [];
      if (row.provider !== "google") reasons.push("provider");
      if (row.providerCalendarId !== row.calendarId)
        reasons.push("providerCalendarId");
      if (row.providerEventId !== row.googleEventId) reasons.push("providerEventId");
      if (row.providerUpdatedMs !== row.googleUpdatedMs)
        reasons.push("providerUpdatedMs");
      if (row.providerSeriesId !== row.recurringEventId)
        reasons.push("providerSeriesId");
      if (row.color !== row.colorId) reasons.push("color");
      if (
        row.busy !==
        (row.transparency === undefined
          ? undefined
          : row.transparency !== "transparent")
      ) reasons.push("busy");
      add(row._id, reasons);
    }
    return finish(page);
  }
  if (phase === "calendarOperations") {
    const page = await ctx.db
      .query("calendarOperations")
      .paginate({ cursor, numItems });
    for (const row of page.page) {
      const connection = await ctx.db.get(row.connectionId);
      const reasons =
        !connection || connection.userId !== row.userId
          ? ["connectionOwner"]
          : [];
      if (row.bookingId) {
        const booking = await ctx.db.get(row.bookingId);
        if (!booking || booking.hostUserId !== row.userId)
          reasons.push("bookingOwner");
      }
      add(row._id, reasons);
    }
    return finish(page);
  }
  if (phase === "connectionBackfillUsers") {
    const page = await ctx.db
      .query("connectionBackfillUsers")
      .paginate({ cursor, numItems });
    for (const row of page.page) {
      add(row._id, row.completedAt === undefined ? ["incomplete"] : []);
    }
    return finish(page);
  }
  const page = await ctx.db.query("people").paginate({ cursor, numItems });
  for (const row of page.page) {
    const connections = await googleConnection(ctx, row.userId);
    const reasons: string[] = [];
    if (connections.length !== 1) reasons.push("googleConnectionCount");
    const connection = connections[0];
    if (connection) {
      const state = await ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", connection._id))
        .unique();
      for (const source of ["connection", "other"] as const) {
        if (!row.sources.includes(source)) continue;
        const claims = await ctx.db
          .query("personSourceClaims")
          .withIndex("by_user_and_email_and_source", (q) =>
            q.eq("userId", row.userId).eq("email", row.email).eq("source", source),
          )
          .collect();
        if (claims.length === 0) {
          reasons.push(`${source}Claims`);
          continue;
        }
        if (claims.some((claim) => claim.providerContactId === undefined)) {
          reasons.push(`${source}ClaimIdentity`);
        }
        let materialized = false;
        for (const claim of claims) {
          if (claim.connectionId !== connection._id || !claim.providerContactId) {
            continue;
          }
          if (source === "connection") {
            const contacts = await ctx.db
              .query("contacts")
              .withIndex("by_user_and_resourceName", (q) =>
                q
                  .eq("userId", row.userId)
                  .eq("resourceName", claim.providerContactId!),
            )
            .collect();
            materialized = contacts.some((contact) =>
              contact.emails
                .map((email) => email.trim().toLowerCase())
                .includes(row.email),
            );
          } else {
            const other = await ctx.db
              .query("otherContactSources")
              .withIndex("by_connection_and_providerContactId", (q) =>
                q
                  .eq("connectionId", connection._id)
                  .eq("providerContactId", claim.providerContactId!),
              )
              .unique();
            materialized =
              other?.emails
                .map((email) => email.trim().toLowerCase())
                .includes(row.email) ?? false;
          }
          if (materialized) break;
        }
        if (!materialized) reasons.push(`${source}Materialization`);
      }
      if (row.sources.includes("other") && state?.otherContactsBackfillRequired) {
        reasons.push("otherContactsFullSyncRequired");
      }
    }
    add(row._id, reasons);
  }
  return finish(page);
}

/**
 * Exact, cursor-paginated verification. A phase is verified only when callers
 * walk until isDone; no sampling or table-wide collect is used.
 */
export const verifyParity = internalQuery({
  args: {
    phase: v.optional(verificationPhaseValidator),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
    // Retained as a compatibility alias for the previous internal command.
    sampleLimit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<VerificationPage> => {
    const requested = args.numItems ?? args.sampleLimit ?? ROW_BATCH;
    const numItems = Math.max(1, Math.min(Math.floor(requested), VERIFY_BATCH_MAX));
    return await verifyPage(
      ctx,
      args.phase ?? "syncState",
      args.cursor ?? null,
      numItems,
    );
  },
});
