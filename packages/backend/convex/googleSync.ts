import type { GenericCtx } from "@convex-dev/better-auth";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import {
  fetchCalendarList,
  fetchCalendarPage,
  fetchContactsPage,
  SyncTokenExpiredError,
} from "./lib/google";

// Validators for data pushed from actions into mutations (mapped Google shapes).
const eventValidator = v.object({
  googleEventId: v.string(),
  calendarId: v.string(),
  summary: v.optional(v.string()),
  description: v.optional(v.string()),
  location: v.optional(v.string()),
  startMs: v.number(),
  endMs: v.number(),
  allDay: v.boolean(),
  status: v.string(),
  htmlLink: v.optional(v.string()),
  colorId: v.optional(v.string()),
  visibility: v.optional(v.string()),
  googleUpdatedMs: v.number(),
});

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
  backgroundColor: v.optional(v.string()),
  foregroundColor: v.optional(v.string()),
  primary: v.optional(v.boolean()),
  accessRole: v.optional(v.string()),
  timeZone: v.optional(v.string()),
});

// ---------------------------------------------------------------------------
// Token helper — resolves a fresh (auto-refreshed) Google access token for a
// user via better-auth. Passing no `headers` makes better-auth resolve by
// `userId` (works from both authenticated actions and session-less crons).
// ---------------------------------------------------------------------------
async function getGoogleAccessToken(
  ctx: GenericCtx<DataModel>,
  userId: string,
): Promise<string> {
  const { accessToken } = await createAuth(ctx).api.getAccessToken({
    body: { providerId: "google", userId },
  });
  if (!accessToken) {
    throw new Error("No Google access token available for user");
  }
  return accessToken;
}

// ---------------------------------------------------------------------------
// Sync orchestration (plain helpers run inside actions).
// ---------------------------------------------------------------------------
// How far back a full (first-time) resync reaches. Events older than this at
// sync time are never fetched; incremental syncs afterwards are unbounded.
const CALENDAR_HISTORY_MS = 365 * 24 * 60 * 60 * 1000;

async function syncCalendar(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
): Promise<void> {
  // Enumerate the account's calendars and persist their metadata, then sync
  // each one independently (each has its own Google sync token).
  const calendars = await fetchCalendarList(accessToken);

  // First sync under the per-calendar model: no calendar rows exist yet, so
  // drop any legacy events (all stamped calendarId "primary") to avoid orphans
  // once the full resync re-inserts them under their real calendar ids.
  const preexisting = await ctx.runQuery(
    internal.googleSync.listCalendarsForUser,
    { userId },
  );
  if (preexisting.length === 0) {
    await ctx.runMutation(internal.googleSync.clearEventsForUser, { userId });
  }

  await ctx.runMutation(internal.googleSync.upsertCalendars, {
    userId,
    calendars,
  });

  const stored = await ctx.runQuery(internal.googleSync.listCalendarsForUser, {
    userId,
  });
  const timeMinMs = Date.now() - CALENDAR_HISTORY_MS;
  for (const cal of stored) {
    await syncOneCalendar(ctx, userId, accessToken, cal, timeMinMs);
  }
}

async function syncOneCalendar(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
  cal: { googleCalendarId: string; syncToken?: string },
  timeMinMs: number,
): Promise<void> {
  let syncToken = cal.syncToken;
  let fullResync = !syncToken;

  // Retry once: if the sync token is expired (410) we restart as a full resync.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let pageToken: string | undefined;
      let newSyncToken: string | undefined;
      do {
        const page = await fetchCalendarPage(accessToken, {
          calendarId: cal.googleCalendarId,
          syncToken: fullResync ? undefined : syncToken,
          pageToken,
          timeMinMs: fullResync ? timeMinMs : undefined,
        });
        if (page.events.length > 0) {
          await ctx.runMutation(internal.googleSync.upsertEventsPage, {
            userId,
            events: page.events,
          });
        }
        pageToken = page.nextPageToken;
        newSyncToken = page.nextSyncToken ?? newSyncToken;
      } while (pageToken);

      if (newSyncToken) {
        await ctx.runMutation(internal.googleSync.setCalendarSyncToken, {
          userId,
          googleCalendarId: cal.googleCalendarId,
          syncToken: newSyncToken,
        });
      }
      return;
    } catch (err) {
      if (err instanceof SyncTokenExpiredError) {
        fullResync = true;
        syncToken = undefined;
        continue;
      }
      throw err;
    }
  }
}

async function syncContacts(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
): Promise<void> {
  const state = await ctx.runQuery(internal.googleSync.getSyncState, { userId });
  let syncToken = state?.contactsSyncToken;
  let fullResync = !syncToken;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let pageToken: string | undefined;
      let newSyncToken: string | undefined;
      do {
        const page = await fetchContactsPage(accessToken, {
          syncToken: fullResync ? undefined : syncToken,
          pageToken,
          requestSyncToken: fullResync ? true : undefined,
        });
        if (page.contacts.length > 0) {
          await ctx.runMutation(internal.googleSync.upsertContactsPage, {
            userId,
            contacts: page.contacts,
          });
        }
        pageToken = page.nextPageToken;
        newSyncToken = page.nextSyncToken ?? newSyncToken;
      } while (pageToken);

      if (newSyncToken) {
        await ctx.runMutation(internal.googleSync.setContactsSync, {
          userId,
          syncToken: newSyncToken,
        });
      }
      return;
    } catch (err) {
      if (err instanceof SyncTokenExpiredError) {
        fullResync = true;
        syncToken = undefined;
        continue;
      }
      throw err;
    }
  }
}

async function runSyncForUser(ctx: ActionCtx, userId: string): Promise<void> {
  await ctx.runMutation(internal.googleSync.ensureSyncState, { userId });
  await ctx.runMutation(internal.googleSync.setSyncStatus, {
    userId,
    status: "syncing",
  });
  try {
    const accessToken = await getGoogleAccessToken(ctx, userId);
    await syncCalendar(ctx, userId, accessToken);
    await syncContacts(ctx, userId, accessToken);
    await ctx.runMutation(internal.googleSync.setSyncStatus, {
      userId,
      status: "idle",
    });
  } catch (err) {
    await ctx.runMutation(internal.googleSync.setSyncStatus, {
      userId,
      status: "error",
      lastError: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public + internal Convex functions
// ---------------------------------------------------------------------------

/** Called by the authenticated client to register + sync the current user. */
export const syncNow = action({
  args: {},
  handler: async (ctx): Promise<null> => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    await runSyncForUser(ctx, user._id);
    return null;
  },
});

/** Per-user sync run, scheduled by the cron. */
export const syncUser = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    await runSyncForUser(ctx, args.userId);
    return null;
  },
});

/** Fan out a sync for every registered user (called by the cron). */
export const enqueueSyncs = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const rows = await ctx.db.query("syncState").collect();
    for (const row of rows) {
      await ctx.scheduler.runAfter(0, internal.googleSync.syncUser, {
        userId: row.userId,
      });
    }
    return null;
  },
});

export const getSyncState = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
  },
});

export const ensureSyncState = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const existing = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!existing) {
      await ctx.db.insert("syncState", { userId: args.userId, status: "idle" });
    }
    return null;
  },
});

export const setSyncStatus = internalMutation({
  args: {
    userId: v.string(),
    status: v.union(
      v.literal("idle"),
      v.literal("syncing"),
      v.literal("error"),
    ),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        status: args.status,
        lastError: args.status === "error" ? args.lastError : undefined,
      });
    }
    return null;
  },
});

export const clearEventsForUser = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const rows = await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

export const listCalendarsForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

export const upsertCalendars = internalMutation({
  args: { userId: v.string(), calendars: v.array(calendarValidator) },
  handler: async (ctx, args): Promise<null> => {
    for (const cal of args.calendars) {
      const existing = await ctx.db
        .query("calendars")
        .withIndex("by_user_and_googleCalendarId", (q) =>
          q
            .eq("userId", args.userId)
            .eq("googleCalendarId", cal.googleCalendarId),
        )
        .unique();
      if (existing) {
        // Preserve the user's `selected` choice and the stored sync token.
        await ctx.db.patch(existing._id, cal);
      } else {
        await ctx.db.insert("calendars", {
          userId: args.userId,
          selected: true,
          ...cal,
        });
      }
    }
    return null;
  },
});

export const setCalendarSyncToken = internalMutation({
  args: {
    userId: v.string(),
    googleCalendarId: v.string(),
    syncToken: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q.eq("userId", args.userId).eq("googleCalendarId", args.googleCalendarId),
      )
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        syncToken: args.syncToken,
        lastSyncAt: Date.now(),
      });
    }
    return null;
  },
});

export const setContactsSync = internalMutation({
  args: { userId: v.string(), syncToken: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        contactsSyncToken: args.syncToken,
        lastContactsSyncAt: Date.now(),
      });
    }
    return null;
  },
});

export const upsertEventsPage = internalMutation({
  args: { userId: v.string(), events: v.array(eventValidator) },
  handler: async (ctx, args): Promise<null> => {
    for (const e of args.events) {
      const existing = await ctx.db
        .query("events")
        .withIndex("by_user_and_calendar_and_googleEventId", (q) =>
          q
            .eq("userId", args.userId)
            .eq("calendarId", e.calendarId)
            .eq("googleEventId", e.googleEventId),
        )
        .unique();
      if (e.status === "cancelled") {
        if (existing) {
          await ctx.db.delete(existing._id);
        }
        continue;
      }
      if (existing) {
        await ctx.db.patch(existing._id, e);
      } else {
        await ctx.db.insert("events", { userId: args.userId, ...e });
      }
    }
    return null;
  },
});

export const upsertContactsPage = internalMutation({
  args: { userId: v.string(), contacts: v.array(contactValidator) },
  handler: async (ctx, args): Promise<null> => {
    for (const c of args.contacts) {
      const existing = await ctx.db
        .query("contacts")
        .withIndex("by_user_and_resourceName", (q) =>
          q.eq("userId", args.userId).eq("resourceName", c.resourceName),
        )
        .unique();
      if (c.deleted) {
        if (existing) {
          await ctx.db.delete(existing._id);
        }
        continue;
      }
      const { deleted: _deleted, ...rest } = c;
      if (existing) {
        await ctx.db.patch(existing._id, rest);
      } else {
        await ctx.db.insert("contacts", { userId: args.userId, ...rest });
      }
    }
    return null;
  },
});
