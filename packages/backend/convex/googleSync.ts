import type { GenericCtx } from "@convex-dev/better-auth";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { DataModel, Doc } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import {
  fetchCalendarList,
  fetchCalendarPage,
  fetchContactsPage,
  fetchOtherContactsPage,
  SyncTokenExpiredError,
} from "./lib/google";
import { googleEventValidator } from "./schema";

// Validators for data pushed from actions into mutations (mapped Google shapes).
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

const EVENT_CLEANUP_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// People directory — the email-keyed union of saved connections, Other
// Contacts, and calendar attendees. Every feeder funnels through
// `upsertPeopleRows` so the merge rule lives in one place.
// ---------------------------------------------------------------------------
type PersonSource = "connection" | "other" | "attendee";

type PersonInput = { email: string; displayName?: string; photoUrl?: string };

/** One event's people (attendees + organizer + creator), minus the user
 * themselves. Shared by the live event upsert and the backfill so both harvest
 * the same set. `self` is Google's authoritative "this is you" flag. */
function collectEventPeople(e: {
  attendees?: { email: string; displayName?: string; self?: boolean }[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; displayName?: string; self?: boolean };
}): PersonInput[] {
  const rows: PersonInput[] = [];
  for (const a of e.attendees ?? []) {
    if (!a.self && a.email) {
      rows.push({ email: a.email, displayName: a.displayName });
    }
  }
  for (const p of [e.organizer, e.creator]) {
    if (p && !p.self && p.email) {
      rows.push({ email: p.email, displayName: p.displayName });
    }
  }
  return rows;
}

/** Merge people rows into the `people` table, keyed by lowercased email.
 *
 * Merge rule: "connection" and "other" are authoritative Google records, so
 * they refresh the name and photo when they carry one; "attendee" only fills
 * blanks and never touches the photo (calendar data has none) — so harvesting a
 * guest can never wipe a real photo a contact sync provided. Idempotent. */
async function upsertPeopleRows(
  ctx: MutationCtx,
  userId: string,
  source: PersonSource,
  rows: PersonInput[],
): Promise<void> {
  const authoritative = source !== "attendee";
  // Collapse duplicate emails within the page (same guest across many events).
  const byEmail = new Map<string, PersonInput>();
  for (const r of rows) {
    const email = r.email.trim().toLowerCase();
    if (!email) {
      continue;
    }
    const prev = byEmail.get(email);
    byEmail.set(email, {
      email,
      displayName: r.displayName ?? prev?.displayName,
      photoUrl: r.photoUrl ?? prev?.photoUrl,
    });
  }
  const now = Date.now();
  for (const r of byEmail.values()) {
    const existing = await ctx.db
      .query("people")
      .withIndex("by_user_and_email", (q) =>
        q.eq("userId", userId).eq("email", r.email),
      )
      .unique();
    if (existing) {
      const sources = existing.sources.includes(source)
        ? existing.sources
        : [...existing.sources, source];
      await ctx.db.patch(existing._id, {
        displayName: authoritative
          ? (r.displayName ?? existing.displayName)
          : (existing.displayName ?? r.displayName),
        photoUrl: authoritative
          ? (r.photoUrl ?? existing.photoUrl)
          : existing.photoUrl,
        sources,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("people", {
        userId,
        email: r.email,
        displayName: r.displayName,
        photoUrl: r.photoUrl,
        sources: [source],
        updatedAt: now,
      });
    }
  }
}

/** Fan a mapped-contact page (connections or Other Contacts) into people rows,
 * skipping tombstones. */
function contactsToPeople(
  contacts: {
    deleted: boolean;
    displayName?: string;
    emails: string[];
    photoUrl?: string;
  }[],
): PersonInput[] {
  const rows: PersonInput[] = [];
  for (const c of contacts) {
    if (c.deleted) {
      continue;
    }
    for (const email of c.emails) {
      rows.push({ email, displayName: c.displayName, photoUrl: c.photoUrl });
    }
  }
  return rows;
}

async function deleteCalendarEventsBatch(
  ctx: MutationCtx,
  userId: string,
  googleCalendarId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query("events")
    .withIndex("by_user_and_calendar", (q) =>
      q.eq("userId", userId).eq("calendarId", googleCalendarId),
    )
    .take(EVENT_CLEANUP_BATCH_SIZE);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length === EVENT_CLEANUP_BATCH_SIZE;
}

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
export const CALENDAR_HISTORY_MS = 365 * 24 * 60 * 60 * 1000;

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
    let hasMoreLegacyEvents: boolean;
    do {
      hasMoreLegacyEvents = await ctx.runMutation(
        internal.googleSync.clearCalendarEventsBatch,
        { userId, googleCalendarId: "primary" },
      );
    } while (hasMoreLegacyEvents);
  }

  const stored: { googleCalendarId: string; syncToken?: string }[] =
    await ctx.runMutation(internal.googleSync.reconcileCalendars, {
      userId,
      calendars,
    });
  const timeMinMs = Date.now() - CALENDAR_HISTORY_MS;
  for (const cal of stored) {
    await syncOneCalendar(ctx, userId, accessToken, cal, timeMinMs);
  }
}

export async function syncOneCalendar(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
  cal: { googleCalendarId: string; syncToken?: string },
  timeMinMs: number,
): Promise<void> {
  let syncToken = cal.syncToken;
  let fullResync = !syncToken;
  let preparedForFullResync = false;

  // Retry once: if the sync token is expired (410) we restart as a full resync.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (fullResync && !preparedForFullResync) {
        await ctx.runMutation(internal.googleSync.resetCalendarSyncState, {
          userId,
          googleCalendarId: cal.googleCalendarId,
        });
        let hasMoreEvents: boolean;
        do {
          hasMoreEvents = await ctx.runMutation(
            internal.googleSync.clearCalendarEventsBatch,
            { userId, googleCalendarId: cal.googleCalendarId },
          );
        } while (hasMoreEvents);
        preparedForFullResync = true;
      }

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
        if (attempt === 1) {
          throw err;
        }
        fullResync = true;
        syncToken = undefined;
        preparedForFullResync = false;
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

/** Sync the People API "Other contacts" list into the people directory. Mirrors
 * `syncContacts`: incremental via `otherContactsSyncToken`, restarting a full
 * resync when Google expires the token. This is the source of avatars for people
 * the user has interacted with but never saved. */
async function syncOtherContacts(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
): Promise<void> {
  const state = await ctx.runQuery(internal.googleSync.getSyncState, { userId });
  let syncToken = state?.otherContactsSyncToken;
  let fullResync = !syncToken;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let pageToken: string | undefined;
      let newSyncToken: string | undefined;
      do {
        const page = await fetchOtherContactsPage(accessToken, {
          syncToken: fullResync ? undefined : syncToken,
          pageToken,
          requestSyncToken: fullResync ? true : undefined,
        });
        if (page.contacts.length > 0) {
          await ctx.runMutation(internal.googleSync.upsertOtherContactsPage, {
            userId,
            contacts: page.contacts,
          });
        }
        pageToken = page.nextPageToken;
        newSyncToken = page.nextSyncToken ?? newSyncToken;
      } while (pageToken);

      if (newSyncToken) {
        await ctx.runMutation(internal.googleSync.setOtherContactsSync, {
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
    await syncOtherContacts(ctx, userId, accessToken);
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

/** Re-fetch every calendar from scratch, discarding the stored sync tokens.
 *
 * Incremental sync only returns events Google considers *changed*, so adding a
 * field to the event schema never reaches a row that nobody has touched — it
 * would sit there missing the new field forever, and the cron would not fix it.
 * Dropping the token is the only way to backfill. Run this by hand from the
 * dashboard after adding event fields; passing no `syncToken` puts
 * `syncOneCalendar` on its full-resync path, which clears each calendar's rows
 * before refetching (so the grid blanks briefly). */
export const forceFullResync = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const accessToken = await getGoogleAccessToken(ctx, args.userId);
    const calendars = await ctx.runQuery(
      internal.googleSync.listCalendarsForUser,
      { userId: args.userId },
    );
    const timeMinMs = Date.now() - CALENDAR_HISTORY_MS;
    for (const cal of calendars) {
      await syncOneCalendar(
        ctx,
        args.userId,
        accessToken,
        { googleCalendarId: cal.googleCalendarId },
        timeMinMs,
      );
    }
    return null;
  },
});

/** One-time backfill of the `people` directory from data already stored.
 *
 * Contacts and events sync incrementally, so neither re-emits rows that haven't
 * changed since the `people` table was introduced — connections and existing
 * attendees would never reach the new directory on their own. This walks the
 * `contacts` and then the `events` table in batches (self-scheduling across
 * transactions) and funnels each through the same idempotent `upsertPeopleRows`
 * merge, so it is safe to re-run. Other Contacts need no backfill: their first
 * sync is a full resync. Run by hand from the dashboard after deploying. */
export const backfillPeople = internalMutation({
  args: {
    phase: v.optional(v.union(v.literal("contacts"), v.literal("events"))),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const phase = args.phase ?? "contacts";
    const BATCH = 100;
    const page = await ctx.db
      .query(phase === "contacts" ? "contacts" : "events")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH });

    if (phase === "contacts") {
      for (const c of page.page as Doc<"contacts">[]) {
        await upsertPeopleRows(ctx, c.userId, "connection", [
          ...c.emails.map((email) => ({
            email,
            displayName: c.displayName,
            photoUrl: c.photoUrl,
          })),
        ]);
      }
    } else {
      for (const e of page.page as Doc<"events">[]) {
        await upsertPeopleRows(ctx, e.userId, "attendee", collectEventPeople(e));
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.googleSync.backfillPeople, {
        phase,
        cursor: page.continueCursor,
      });
    } else if (phase === "contacts") {
      // Contacts done — move on to harvesting people from existing events.
      await ctx.scheduler.runAfter(0, internal.googleSync.backfillPeople, {
        phase: "events",
      });
    }
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

export const listCalendarsForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

export const reconcileCalendars = internalMutation({
  args: { userId: v.string(), calendars: v.array(calendarValidator) },
  handler: async (
    ctx,
    args,
  ): Promise<{ googleCalendarId: string; syncToken?: string }[]> => {
    const existingCalendars = await ctx.db
      .query("calendars")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    const existingByGoogleId = new Map(
      existingCalendars.map((calendar) => [
        calendar.googleCalendarId,
        calendar,
      ]),
    );
    const currentGoogleIds = new Set(
      args.calendars.map((calendar) => calendar.googleCalendarId),
    );
    const stored: { googleCalendarId: string; syncToken?: string }[] = [];

    for (const cal of args.calendars) {
      const existing = existingByGoogleId.get(cal.googleCalendarId);
      if (existing) {
        // Patch every Google-owned field explicitly so removed optional
        // metadata is removed locally too. Local selection and sync state stay
        // untouched.
        await ctx.db.patch(existing._id, {
          summary: cal.summary,
          summaryOverride: cal.summaryOverride,
          backgroundColor: cal.backgroundColor,
          foregroundColor: cal.foregroundColor,
          primary: cal.primary,
          accessRole: cal.accessRole,
          timeZone: cal.timeZone,
          googleSelected: cal.googleSelected,
        });
        stored.push({
          googleCalendarId: cal.googleCalendarId,
          syncToken: existing.syncToken,
        });
      } else {
        await ctx.db.insert("calendars", {
          userId: args.userId,
          selected: cal.googleSelected ?? false,
          ...cal,
        });
        stored.push({ googleCalendarId: cal.googleCalendarId });
      }
    }

    for (const existing of existingCalendars) {
      if (currentGoogleIds.has(existing.googleCalendarId)) {
        continue;
      }
      // Removing the calendar row immediately hides its remaining events from
      // authenticated queries. Event cleanup continues in bounded mutations.
      await ctx.db.delete(existing._id);
      await ctx.scheduler.runAfter(
        0,
        internal.googleSync.cleanupRemovedCalendarEvents,
        {
          userId: args.userId,
          googleCalendarId: existing.googleCalendarId,
        },
      );
    }

    return stored;
  },
});

/** Clear a calendar's events one bounded transaction at a time. Actions loop
 * over this for a full resync; removed-calendar cleanup uses the scheduled
 * wrapper below. */
export const clearCalendarEventsBatch = internalMutation({
  args: { userId: v.string(), googleCalendarId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    return await deleteCalendarEventsBatch(
      ctx,
      args.userId,
      args.googleCalendarId,
    );
  },
});

/** Continue deleting orphaned events unless the calendar was re-added before
 * this scheduled batch ran. */
export const cleanupRemovedCalendarEvents = internalMutation({
  args: { userId: v.string(), googleCalendarId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const calendar = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q
          .eq("userId", args.userId)
          .eq("googleCalendarId", args.googleCalendarId),
      )
      .unique();
    if (calendar) {
      return null;
    }

    const hasMore = await deleteCalendarEventsBatch(
      ctx,
      args.userId,
      args.googleCalendarId,
    );
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.googleSync.cleanupRemovedCalendarEvents,
        args,
      );
    }
    return null;
  },
});

/** Drop an invalid/partial full-sync token before clearing and refetching that
 * calendar. */
export const resetCalendarSyncState = internalMutation({
  args: { userId: v.string(), googleCalendarId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q
          .eq("userId", args.userId)
          .eq("googleCalendarId", args.googleCalendarId),
      )
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        syncToken: undefined,
        lastSyncAt: undefined,
      });
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

export const setOtherContactsSync = internalMutation({
  args: { userId: v.string(), syncToken: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        otherContactsSyncToken: args.syncToken,
        lastOtherContactsSyncAt: Date.now(),
      });
    }
    return null;
  },
});

export const upsertEventsPage = internalMutation({
  args: { userId: v.string(), events: v.array(googleEventValidator) },
  handler: async (ctx, args): Promise<null> => {
    const harvested: PersonInput[] = [];
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
        // A mapped Google event is an authoritative snapshot. Replacing the row
        // also clears optional fields that Google removed from the event.
        await ctx.db.replace(existing._id, { userId: args.userId, ...e });
      } else {
        await ctx.db.insert("events", { userId: args.userId, ...e });
      }
      harvested.push(...collectEventPeople(e));
    }
    // Harvest guests/organizers into the people directory so anyone the user
    // meets with becomes a known contact (name only — calendar carries no photo).
    await upsertPeopleRows(ctx, args.userId, "attendee", harvested);
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
    // Mirror saved connections into the email-keyed people directory.
    await upsertPeopleRows(
      ctx,
      args.userId,
      "connection",
      contactsToPeople(args.contacts),
    );
    return null;
  },
});

/** Merge a page of People API "Other contacts" into the people directory. These
 * never land in the `contacts` table (they aren't saved contacts); they exist
 * only to enrich attendees with a name + avatar. */
export const upsertOtherContactsPage = internalMutation({
  args: { userId: v.string(), contacts: v.array(contactValidator) },
  handler: async (ctx, args): Promise<null> => {
    await upsertPeopleRows(
      ctx,
      args.userId,
      "other",
      contactsToPeople(args.contacts),
    );
    return null;
  },
});
