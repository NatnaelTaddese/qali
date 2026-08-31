/** Write side of the calendar domain that stays local (no provider calls):
 * the visibility toggle and the optimistic-mirror internal mutations.
 * Registration is canonical here, under `api.domains.calendar.mutations.*` /
 * `internal.domains.calendar.mutations.*`. */

import { ConvexError, v, type Infer } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "../../_generated/server";
import { authComponent } from "../../auth";
import {
  ensureConnectionSyncState,
  ensureDefaultPrimaryCalendar,
  ensureGoogleConnection,
  preferredConnection,
} from "./connections";
import { providerEventValidator } from "./validators";

/** Access roles that allow writing events. The single backend source — the
 * preferences domain's default-calendar validation imports it. */
export const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer"]);
const CALENDAR_OPERATION_LEASE_MS = 10 * 60 * 1000;
/** How long a connection whose profile fetch came back nameless waits before
 * the next attempt. Without it, an unstampable grant re-fetches a token and
 * hits userinfo on every user-initiated sync — i.e. every page load. */
const IDENTITY_RETRY_MS = 24 * 60 * 60 * 1000;

/** Resolve an owned local calendar row to a writable provider target. */
export async function resolveCreateTargetHandler(
  ctx: MutationCtx,
  args: { userId: string; requestedCalendarId?: Id<"calendars"> },
) {
  let calendar = args.requestedCalendarId
    ? await ctx.db.get(args.requestedCalendarId)
    : null;
  if (calendar && calendar.userId !== args.userId) {
    throw new Error("Calendar not found");
  }
  if (!calendar && args.requestedCalendarId) {
    throw new Error("Calendar not found");
  }
  if (!calendar) {
    const calendars = await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(501);
    if (calendars.length > 500) {
      throw new Error("Too many calendars to choose a write target safely");
    }
    const primaries = calendars.filter((row) => row.primary);
    calendar = primaries[0] ?? null;
    if (primaries.length > 1) {
      // Several connected accounts each have a `primary` calendar; the
      // preferred connection's one is the deterministic default.
      const connections = await ctx.db
        .query("calendarConnections")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .take(101);
      if (connections.length > 100) {
        throw new Error("Too many connections to choose a write target safely");
      }
      const preferred = preferredConnection(connections);
      calendar =
        primaries.find((row) => row.connectionId === preferred?._id) ??
        primaries[0];
    }
  }
  if (!calendar && !args.requestedCalendarId) {
    const connectionId = await ensureGoogleConnection(ctx, args.userId);
    calendar = await ensureDefaultPrimaryCalendar(
      ctx,
      args.userId,
      connectionId,
    );
  }
  if (!calendar) throw new Error("Calendar not found");
  if (!WRITABLE_ACCESS_ROLES.has(calendar.accessRole ?? "")) {
    throw new Error("This calendar is read-only");
  }
  const connectionId = calendar.connectionId;
  const providerCalendarId = calendar.providerCalendarId;
  if (connectionId === undefined || providerCalendarId === undefined) {
    throw new ConvexError("Calendar not synced yet");
  }
  const connection = await ctx.db.get(connectionId);
  if (!connection || connection.userId !== args.userId) {
    throw new Error("Calendar connection is unavailable");
  }
  return {
    connectionId,
    localCalendarId: calendar._id,
    providerCalendarId,
  };
}

export const resolveCreateTarget = internalMutation({
  args: {
    userId: v.string(),
    requestedCalendarId: v.optional(v.id("calendars")),
  },
  handler: (ctx, args) => resolveCreateTargetHandler(ctx, args),
});

/** Bring the connection rows in line with the Google grants Better Auth holds
 * for the user. Each grant is keyed by `credentialRef` (the provider account
 * id Better Auth resolves tokens by); a lone pre-linking connection — the
 * login grant, which predates every link — claims the oldest unclaimed grant
 * instead of being duplicated. Idempotent: re-running with the same grants
 * changes nothing. */
export async function reconcileLinkedAccountsHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    accounts: { credentialRef: string; createdAt: number }[];
  },
): Promise<{
  created: number;
  pendingIdentity: {
    connectionId: Id<"calendarConnections">;
    credentialRef: string;
  }[];
}> {
  const connections = await ctx.db
    .query("calendarConnections")
    .withIndex("by_user_and_provider", (q) =>
      q.eq("userId", args.userId).eq("provider", "google"),
    )
    .take(101);
  if (connections.length > 100) {
    throw new Error("Too many connections to reconcile safely");
  }
  // Rows whose grant is known but whose profile (name/photo) isn't stamped
  // yet — the caller fetches those from the provider, action-side. A fetch
  // that came back empty (or threw) still stamps its attempt, so a grant that
  // can never yield a name is retried daily rather than on every sync.
  const now = Date.now();
  const pendingIdentity: {
    connectionId: Id<"calendarConnections">;
    credentialRef: string;
  }[] = [];
  for (const row of connections) {
    if (
      row.credentialRef !== undefined &&
      row.providerAccountName === undefined &&
      now - (row.providerIdentityAttemptedAt ?? 0) > IDENTITY_RETRY_MS
    ) {
      pendingIdentity.push({
        connectionId: row._id,
        credentialRef: row.credentialRef,
      });
    }
  }
  const claimed = new Set(
    connections
      .map((row) => row.credentialRef)
      .filter((ref) => ref !== undefined),
  );
  const unclaimed = args.accounts
    .filter((account) => !claimed.has(account.credentialRef))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (unclaimed.length === 0) return { created: 0, pendingIdentity };
  const legacy = connections.filter((row) => row.credentialRef === undefined);
  if (legacy.length === 1) {
    const oldest = unclaimed.shift()!;
    await ctx.db.patch(legacy[0]._id, {
      credentialRef: oldest.credentialRef,
      updatedAt: now,
    });
    if (legacy[0].providerAccountName === undefined) {
      pendingIdentity.push({
        connectionId: legacy[0]._id,
        credentialRef: oldest.credentialRef,
      });
    }
  }
  let created = 0;
  for (const account of unclaimed) {
    const connectionId = await ctx.db.insert("calendarConnections", {
      userId: args.userId,
      provider: "google",
      credentialRef: account.credentialRef,
      status: "active",
      capabilities: { contacts: true, idempotentCreate: true },
      createdAt: now,
      updatedAt: now,
    });
    await ensureConnectionSyncState(ctx, args.userId, connectionId);
    pendingIdentity.push({ connectionId, credentialRef: account.credentialRef });
    created += 1;
  }
  return { created, pendingIdentity };
}

export const reconcileLinkedAccounts = internalMutation({
  args: {
    userId: v.string(),
    accounts: v.array(
      v.object({ credentialRef: v.string(), createdAt: v.number() }),
    ),
  },
  returns: v.object({
    created: v.number(),
    pendingIdentity: v.array(
      v.object({
        connectionId: v.id("calendarConnections"),
        credentialRef: v.string(),
      }),
    ),
  }),
  handler: (ctx, args) => reconcileLinkedAccountsHandler(ctx, args),
});

/** Best-effort profile stamp from the provider's ID token: the account email
 * fills `providerAccountId` only when a sync hasn't already, while name and
 * photo are refreshed whenever the provider reports new ones. Called with no
 * profile fields when the fetch failed or came back empty — the attempt is
 * recorded either way, which is what keeps the retry off the sync hot path. */
export const stampConnectionIdentity = internalMutation({
  args: {
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    providerAccountId: v.optional(v.string()),
    providerAccountName: v.optional(v.string()),
    providerAccountImageUrl: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.userId !== args.userId) return null;
    const patch: Partial<Doc<"calendarConnections">> = {
      providerIdentityAttemptedAt: Date.now(),
    };
    if (
      args.providerAccountId !== undefined &&
      connection.providerAccountId === undefined
    ) {
      patch.providerAccountId = args.providerAccountId;
    }
    if (
      args.providerAccountName !== undefined &&
      connection.providerAccountName !== args.providerAccountName
    ) {
      patch.providerAccountName = args.providerAccountName;
    }
    if (
      args.providerAccountImageUrl !== undefined &&
      connection.providerAccountImageUrl !== args.providerAccountImageUrl
    ) {
      patch.providerAccountImageUrl = args.providerAccountImageUrl;
    }
    await ctx.db.patch(args.connectionId, { ...patch, updatedAt: Date.now() });
    return null;
  },
});

/** Take a connection out of the sync fan-out ahead of its purge, so no new
 * sync starts against a grant that is about to be (or was just) revoked. */
export const pauseConnectionForRemoval = internalMutation({
  args: { userId: v.string(), connectionId: v.id("calendarConnections") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection && connection.userId === args.userId) {
      await ctx.db.patch(args.connectionId, {
        status: "paused",
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

/** Resolve neutral event identity before any provider operation. */
export async function resolveEventWriteTargetHandler(
  ctx: MutationCtx,
  args: { userId: string; eventId: Id<"events"> },
) {
  const event = await ctx.db.get(args.eventId);
  if (!event || event.userId !== args.userId) return null;
  const connectionId = event.connectionId;
  const localCalendarId = event.localCalendarId;
  const providerEventId = event.providerEventId;
  if (
    connectionId === undefined ||
    localCalendarId === undefined ||
    providerEventId === undefined
  ) {
    return null;
  }
  const calendar = await ctx.db.get(localCalendarId);
  if (!calendar || calendar.userId !== args.userId) return null;
  if (calendar.connectionId !== connectionId) {
    throw new Error("Calendar connection does not match this event");
  }
  const providerCalendarId = calendar.providerCalendarId;
  if (providerCalendarId === undefined) return null;
  const connection = await ctx.db.get(connectionId);
  if (!connection || connection.userId !== args.userId) {
    throw new Error("Calendar connection is unavailable");
  }
  return {
    event,
    calendar,
    connectionId,
    localCalendarId,
    providerCalendarId,
    providerEventId,
    providerSeriesId: event.providerSeriesId,
  };
}

export const resolveEventWriteTarget = internalMutation({
  args: { userId: v.string(), eventId: v.id("events") },
  handler: (ctx, args) => resolveEventWriteTargetHandler(ctx, args),
});

export async function claimCalendarOperationHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    connectionId: Id<"calendarConnections">;
    localCalendarId: Id<"calendars">;
    providerCalendarId: string;
    providerEventId?: string;
    targetEventId?: Id<"events">;
    targetProviderEventId?: string;
    requestFingerprint: string;
    idempotencyKey: string;
    kind: "create" | "update" | "delete" | "respond";
    attemptId: string;
  },
) {
  const connection = await ctx.db.get(args.connectionId);
  const calendar = await ctx.db.get(args.localCalendarId);
  if (
    !connection ||
    connection.userId !== args.userId ||
    !calendar ||
    calendar.userId !== args.userId ||
    calendar.connectionId !== args.connectionId ||
    calendar.providerCalendarId !== args.providerCalendarId
  ) {
    throw new Error("Calendar operation target is invalid");
  }
  const existing = await ctx.db
    .query("calendarOperations")
    .withIndex("by_connection_and_key", (q) =>
      q
        .eq("connectionId", args.connectionId)
        .eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (existing) {
    // An operation whose local refs were nulled by the provider cutover must
    // adopt the retry's ids rather than reject them — only a *different*
    // stored value proves key reuse.
    if (
      existing.userId !== args.userId ||
      existing.kind !== args.kind ||
      (existing.localCalendarId &&
        existing.localCalendarId !== args.localCalendarId) ||
      (existing.providerCalendarId &&
        existing.providerCalendarId !== args.providerCalendarId) ||
      (existing.targetEventId &&
        existing.targetEventId !== args.targetEventId) ||
      (existing.targetProviderEventId &&
        existing.targetProviderEventId !== args.targetProviderEventId) ||
      (!existing.targetProviderEventId &&
        existing.kind !== "create" &&
        existing.providerEventId !== undefined &&
        existing.providerEventId !== args.targetProviderEventId) ||
      (existing.requestFingerprint &&
        existing.requestFingerprint !== args.requestFingerprint)
    ) {
      throw new Error("Calendar operation key was already used for another write");
    }
    if (existing.status === "succeeded") {
      return {
        state: "succeeded" as const,
        providerEventId: existing.providerEventId,
      };
    }
    if (
      existing.status === "pending" &&
      existing.attemptId &&
      (existing.leaseExpiresAt ?? 0) > Date.now()
    ) {
      throw new Error("This calendar change is already being applied");
    }
    await ctx.db.patch(existing._id, {
      status: "pending",
      attemptId: args.attemptId,
      leaseExpiresAt: Date.now() + CALENDAR_OPERATION_LEASE_MS,
      mayHaveSucceeded: true,
      localCalendarId: args.localCalendarId,
      providerCalendarId: args.providerCalendarId,
      targetEventId: existing.targetEventId ?? args.targetEventId,
      targetProviderEventId:
        existing.targetProviderEventId ?? args.targetProviderEventId,
      requestFingerprint:
        existing.requestFingerprint ?? args.requestFingerprint,
      providerEventId: existing.providerEventId ?? args.providerEventId,
      lastError: undefined,
      updatedAt: Date.now(),
    });
    return {
      state: "claimed" as const,
      reconcileOnly:
        existing.status === "ambiguous" || existing.mayHaveSucceeded === true,
    };
  }
  const now = Date.now();
  await ctx.db.insert("calendarOperations", {
    connectionId: args.connectionId,
    userId: args.userId,
    idempotencyKey: args.idempotencyKey,
    kind: args.kind,
    status: "pending",
    attemptId: args.attemptId,
    leaseExpiresAt: now + CALENDAR_OPERATION_LEASE_MS,
    mayHaveSucceeded: true,
    localCalendarId: args.localCalendarId,
    providerCalendarId: args.providerCalendarId,
    targetEventId: args.targetEventId,
    targetProviderEventId: args.targetProviderEventId,
    requestFingerprint: args.requestFingerprint,
    providerEventId: args.providerEventId,
    createdAt: now,
    updatedAt: now,
  });
  return { state: "claimed" as const, reconcileOnly: false };
}

export const claimCalendarOperation = internalMutation({
  args: {
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    localCalendarId: v.id("calendars"),
    providerCalendarId: v.string(),
    providerEventId: v.optional(v.string()),
    targetEventId: v.optional(v.id("events")),
    targetProviderEventId: v.optional(v.string()),
    requestFingerprint: v.string(),
    idempotencyKey: v.string(),
    kind: v.union(
      v.literal("create"),
      v.literal("update"),
      v.literal("delete"),
      v.literal("respond"),
    ),
    attemptId: v.string(),
  },
  handler: (ctx, args) => claimCalendarOperationHandler(ctx, args),
});

export async function settleCalendarOperationHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    connectionId: Id<"calendarConnections">;
    idempotencyKey: string;
    attemptId: string;
    status: "succeeded" | "ambiguous" | "failed";
    providerEventId?: string;
    error?: string;
  },
): Promise<boolean> {
  const operation = await ctx.db
    .query("calendarOperations")
    .withIndex("by_connection_and_key", (q) =>
      q
        .eq("connectionId", args.connectionId)
        .eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (
    !operation ||
    operation.userId !== args.userId ||
    operation.status !== "pending" ||
    operation.attemptId !== args.attemptId
  ) {
    return false;
  }
  await ctx.db.patch(operation._id, {
    status: args.status,
    attemptId: undefined,
    leaseExpiresAt: undefined,
    mayHaveSucceeded: args.status === "ambiguous" ? true : undefined,
    providerEventId: args.providerEventId ?? operation.providerEventId,
    lastError: args.error,
    updatedAt: Date.now(),
  });
  return true;
}

export const settleCalendarOperation = internalMutation({
  args: {
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    idempotencyKey: v.string(),
    attemptId: v.string(),
    status: v.union(
      v.literal("succeeded"),
      v.literal("ambiguous"),
      v.literal("failed"),
    ),
    providerEventId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: (ctx, args) => settleCalendarOperationHandler(ctx, args),
});

/** Toggle whether a calendar's events appear on the grid. */
export async function setCalendarSelectedHandler(
  ctx: MutationCtx,
  args: { calendarId: Id<"calendars">; selected: boolean },
): Promise<null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }
  const cal = await ctx.db.get(args.calendarId);
  if (!cal || cal.userId !== user._id) {
    throw new Error("Calendar not found");
  }
  await ctx.db.patch(args.calendarId, { selected: args.selected });
  return null;
}

export const setCalendarSelected = mutation({
  args: { calendarId: v.id("calendars"), selected: v.boolean() },
  handler: (ctx, args) => setCalendarSelectedHandler(ctx, args),
});

/** Pause or resume a connection's sync. Only these two states are settable —
 * "error" is the sync engine's to report. Pausing needs no engine change:
 * listActiveConnections, the cron enqueue, and the lease claim all filter on
 * `status === "active"`. Exported core so itests can drive it via t.run. */
export async function setConnectionStatusCore(
  ctx: MutationCtx,
  userId: string,
  args: {
    connectionId: Id<"calendarConnections">;
    status: "active" | "paused";
  },
): Promise<null> {
  const connection = await ctx.db.get(args.connectionId);
  if (!connection || connection.userId !== userId) {
    throw new Error("Connection not found");
  }
  await ctx.db.patch(args.connectionId, {
    status: args.status,
    // Resuming is a fresh start; a stale provider error would read as current.
    ...(args.status === "active" ? { lastError: undefined } : {}),
    updatedAt: Date.now(),
  });
  return null;
}

export const setConnectionStatus = mutation({
  args: {
    connectionId: v.id("calendarConnections"),
    status: v.union(v.literal("active"), v.literal("paused")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    return setConnectionStatusCore(ctx, user._id, args);
  },
});

/** Turn a connection's contacts sync on or off. Writes the user-owned
 * `contactsSyncEnabled` flag — the adapter registry gates the contacts feeder
 * on it alongside the adapter-owned `capabilities.contacts` (registry.ts),
 * which this deliberately never touches. Exported core so itests can drive it. */
export async function setConnectionContactsCore(
  ctx: MutationCtx,
  userId: string,
  args: { connectionId: Id<"calendarConnections">; contacts: boolean },
): Promise<null> {
  const connection = await ctx.db.get(args.connectionId);
  if (!connection || connection.userId !== userId) {
    throw new Error("Connection not found");
  }
  await ctx.db.patch(args.connectionId, {
    contactsSyncEnabled: args.contacts,
    updatedAt: Date.now(),
  });
  return null;
}

export const setConnectionContacts = mutation({
  args: {
    connectionId: v.id("calendarConnections"),
    contacts: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    return setConnectionContactsCore(ctx, user._id, args);
  },
});

const SUMMARY_OVERRIDE_MAX_LENGTH = 200;

/** Rename a calendar locally. An empty or absent name clears the override so
 * calendarDisplayName falls back to the provider's `summary`. */
export async function setCalendarSummaryOverrideCore(
  ctx: MutationCtx,
  userId: string,
  args: { calendarId: Id<"calendars">; summaryOverride?: string },
): Promise<null> {
  const calendar = await ctx.db.get(args.calendarId);
  if (!calendar || calendar.userId !== userId) {
    throw new Error("Calendar not found");
  }
  const trimmed = args.summaryOverride?.trim();
  if (trimmed && trimmed.length > SUMMARY_OVERRIDE_MAX_LENGTH) {
    throw new Error("Calendar name is too long");
  }
  await ctx.db.patch(args.calendarId, {
    summaryOverride: trimmed ? trimmed : undefined,
  });
  return null;
}

export const setCalendarSummaryOverride = mutation({
  args: {
    calendarId: v.id("calendars"),
    summaryOverride: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    return setCalendarSummaryOverrideCore(ctx, user._id, args);
  },
});

/** Store an adapter event as the neutral events row for its local calendar. */
export async function mirrorProviderEventHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    connectionId: Id<"calendarConnections">;
    localCalendarId: Id<"calendars">;
    event: Infer<typeof providerEventValidator>;
  },
): Promise<null> {
  const connection = await ctx.db.get(args.connectionId);
  const calendar = await ctx.db.get(args.localCalendarId);
  if (
    !connection ||
    connection.userId !== args.userId ||
    !calendar ||
    calendar.userId !== args.userId ||
    calendar.connectionId !== args.connectionId ||
    calendar.providerCalendarId !== args.event.calendarId
  ) {
    throw new Error("Calendar event mirror target is invalid");
  }

  const event = args.event;
  const doc: Omit<Doc<"events">, "_id" | "_creationTime"> = {
    userId: args.userId,
    connectionId: args.connectionId,
    localCalendarId: args.localCalendarId,
    providerEventId: event.id,
    providerUpdatedMs: event.updatedMs,
    providerSeriesId: event.seriesId,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startMs: event.startMs,
    endMs: event.endMs,
    allDay: event.allDay,
    status: event.status,
    htmlLink: event.htmlLink,
    color: event.color,
    visibility: event.visibility,
    busy: event.busy,
    attendees: event.attendees
      ?.filter((attendee) => attendee.email !== undefined)
      .map((attendee) => ({
        email: attendee.email!,
        displayName: attendee.displayName,
        responseStatus: attendee.responseStatus,
        organizer: attendee.organizer,
        self: attendee.self,
        optional: attendee.optional,
      })),
    attendeesOmitted: event.attendeesOmitted,
    organizer: event.organizer,
    creator: event.creator,
    guestsCanModify: event.guestsCanModify,
    guestsCanInviteOthers: event.guestsCanInviteOthers,
    guestsCanSeeOtherGuests: event.guestsCanSeeOtherGuests,
    locked: event.locked,
    eventType: event.eventType,
    conferenceUrl: event.conference?.url,
    conferenceName: event.conference?.name,
    conferenceType: event.conference?.type,
  };
  const existing = await ctx.db
    .query("events")
    .withIndex("by_connection_and_localCalendarId_and_providerEventId", (q) =>
      q
        .eq("connectionId", args.connectionId)
        .eq("localCalendarId", args.localCalendarId)
        .eq("providerEventId", event.id),
    )
    .unique();
  if (existing) await ctx.db.replace(existing._id, doc);
  else await ctx.db.insert("events", doc);
  return null;
}

export const mirrorProviderEvent = internalMutation({
  args: {
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    localCalendarId: v.id("calendars"),
    event: providerEventValidator,
  },
  handler: (ctx, args) => mirrorProviderEventHandler(ctx, args),
});

/** Remove an optimistic event row and, for a whole-series write, its rule cache. */
export async function deleteProviderEventMirrorHandler(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    userId: string;
    connectionId: Id<"calendarConnections">;
    localCalendarId: Id<"calendars">;
    providerSeriesId?: string;
  },
): Promise<null> {
  const row = await ctx.db.get(args.eventId);
  if (
    row?.userId === args.userId &&
    row.connectionId === args.connectionId &&
    row.localCalendarId === args.localCalendarId
  ) {
    await ctx.db.delete(row._id);
  }
  if (args.providerSeriesId) {
    const calendar = await ctx.db.get(args.localCalendarId);
    if (calendar?.userId === args.userId) {
      const series = await ctx.db
        .query("recurringSeries")
        .withIndex("by_connection_and_localCalendarId_and_providerEventId", (q) =>
          q
            .eq("connectionId", args.connectionId)
            .eq("localCalendarId", args.localCalendarId)
            .eq("providerEventId", args.providerSeriesId!),
        )
        .unique();
      if (series) await ctx.db.delete(series._id);
    }
  }
  return null;
}

export const deleteProviderEventMirror = internalMutation({
  args: {
    eventId: v.id("events"),
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    localCalendarId: v.id("calendars"),
    providerSeriesId: v.optional(v.string()),
  },
  handler: (ctx, args) => deleteProviderEventMirrorHandler(ctx, args),
});

/** Cache a recurring master by its neutral identity. */
export async function upsertProviderRecurringSeriesHandler(
  ctx: MutationCtx,
  args: {
    userId: string;
    connectionId: Id<"calendarConnections">;
    localCalendarId: Id<"calendars">;
    providerEventId: string;
    recurrence: string[];
    providerUpdatedMs: number;
    replacedEventId?: Id<"events">;
  },
): Promise<null> {
  const connection = await ctx.db.get(args.connectionId);
  const calendar = await ctx.db.get(args.localCalendarId);
  if (
    !connection ||
    connection.userId !== args.userId ||
    !calendar ||
    calendar.userId !== args.userId ||
    calendar.connectionId !== args.connectionId
  ) {
    throw new Error("Recurring series target is invalid");
  }
  const existing = await ctx.db
    .query("recurringSeries")
    .withIndex("by_connection_and_localCalendarId_and_providerEventId", (q) =>
      q
        .eq("connectionId", args.connectionId)
        .eq("localCalendarId", args.localCalendarId)
        .eq("providerEventId", args.providerEventId),
    )
    .unique();
  const value = {
    recurrence: args.recurrence,
    providerSeriesId: args.providerEventId,
    providerUpdatedMs: args.providerUpdatedMs,
  };
  if (existing) await ctx.db.patch(existing._id, value);
  else {
    await ctx.db.insert("recurringSeries", {
      userId: args.userId,
      connectionId: args.connectionId,
      localCalendarId: args.localCalendarId,
      providerEventId: args.providerEventId,
      ...value,
    });
  }
  if (args.replacedEventId) {
    const replaced = await ctx.db.get(args.replacedEventId);
    if (
      replaced?.userId === args.userId &&
      replaced.connectionId === args.connectionId &&
      replaced.localCalendarId === args.localCalendarId &&
      replaced.providerEventId === args.providerEventId
    ) {
      await ctx.db.delete(replaced._id);
    }
  }
  return null;
}

export const upsertProviderRecurringSeries = internalMutation({
  args: {
    userId: v.string(),
    connectionId: v.id("calendarConnections"),
    localCalendarId: v.id("calendars"),
    providerEventId: v.string(),
    recurrence: v.array(v.string()),
    providerUpdatedMs: v.number(),
    replacedEventId: v.optional(v.id("events")),
  },
  handler: (ctx, args) => upsertProviderRecurringSeriesHandler(ctx, args),
});
