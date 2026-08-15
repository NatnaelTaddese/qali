import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { authComponent } from "./auth";
import { isSharedPublicCalendar } from "./lib/calendars";
import { getGoogleAccessToken } from "./lib/googleCredentials";
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

// Adaptive background-sync cadence. A run that changes nothing doubles the poll
// interval from the floor toward the cap; a change or a user-initiated sync
// resets it to the floor. Idle users (app closed) drift to SYNC_MAX_MS between
// Google polls; an open app stays fresh because the client calls syncNow itself.
const SYNC_MIN_MS = 15 * 60 * 1000; // active/floor: every 15 min
const SYNC_MAX_MS = 60 * 60 * 1000; // idle cap: at most once an hour
// How many due users one cron tick schedules per transaction before continuing
// in a fresh one — keeps the fan-out bounded regardless of user count.
const SYNC_FANOUT_BATCH = 100;
// How long a per-user sync lease is held. Comfortably longer than a normal run
// (even a multi-calendar full resync) so a run never loses its own lease
// mid-flight, but short enough that a crashed run's lease is reclaimable soon.
const SYNC_LEASE_MS = 10 * 60 * 1000;

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
  // Full-resync generation for the "other" feeder; stamped onto touched rows so
  // the post-resync sweep can drop "other" from people it no longer sees. Ignored
  // for other sources and on incremental writes (undefined preserves the prior
  // stamp). See sweepStaleOtherPeopleBatch.
  otherGeneration?: number,
): Promise<void> {
  const authoritative = source !== "attendee";
  const stampOther =
    source === "other" && otherGeneration !== undefined
      ? { otherSyncGeneration: otherGeneration }
      : {};
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
        ...stampOther,
      });
    } else {
      await ctx.db.insert("people", {
        userId,
        email: r.email,
        displayName: r.displayName,
        photoUrl: r.photoUrl,
        sources: [source],
        updatedAt: now,
        ...stampOther,
      });
    }
  }
}

/** Remove one feeder's claim on a person, keyed by lowercased email. When that
 * was the person's only source the row is deleted; otherwise the tag is dropped
 * and the row kept (a guest who is also a calendar attendee stays visible).
 * Idempotent — a no-op if the person or source is already gone. */
async function removePersonSource(
  ctx: MutationCtx,
  userId: string,
  email: string,
  source: PersonSource,
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    return;
  }
  const existing = await ctx.db
    .query("people")
    .withIndex("by_user_and_email", (q) =>
      q.eq("userId", userId).eq("email", normalized),
    )
    .unique();
  if (!existing || !existing.sources.includes(source)) {
    return;
  }
  const sources = existing.sources.filter((s) => s !== source);
  if (sources.length === 0) {
    await ctx.db.delete(existing._id);
  } else {
    await ctx.db.patch(existing._id, { sources, updatedAt: Date.now() });
  }
}

// --- Engagement scoring ----------------------------------------------------
// A person's rank in the guest picker: a recency- and intimacy-weighted count
// of the events you share with them. Recomputed from `events` on each sync
// (materialized onto `people`) because the recency decay needs the wall clock,
// which queries may not read.
const DAY_MS = 24 * 60 * 60 * 1000;
// Only score events within the synced window; older ones contribute ~nothing
// after decay anyway. Matches CALENDAR_HISTORY_MS (declared below) so nothing in
// range is missed.
const ENGAGEMENT_WINDOW_MS = 180 * DAY_MS;
// How fast an event's weight halves as it recedes into the past (or future).
const ENGAGEMENT_HALF_LIFE_DAYS = 30;
// Upcoming meetings signal current relevance, so they outweigh an equally-recent
// past one.
const ENGAGEMENT_UPCOMING_BOOST = 1.6;

type Engagement = {
  score: number;
  meetingCount: number;
  lastMetMs?: number;
  nextMeetingMs?: number;
};

/** One event's contribution to a shared person's engagement. `size` is the
 * event's guest count — smaller meetings imply a closer relationship. */
function eventEngagementWeight(startMs: number, size: number, now: number): number {
  const ageDays = Math.abs(now - startMs) / DAY_MS;
  const recency = 2 ** (-ageDays / ENGAGEMENT_HALF_LIFE_DAYS);
  const intimacy = 1 / Math.log2(Math.max(size, 2) + 1);
  const boost = startMs > now ? ENGAGEMENT_UPCOMING_BOOST : 1;
  return recency * intimacy * boost;
}

/** Fold one event into the running per-email engagement map. */
function accumulateEventEngagement(
  byEmail: Map<string, Engagement>,
  event: { startMs: number; status: string; attendees?: { email: string; self?: boolean }[] },
  now: number,
): void {
  if (event.status === "cancelled") {
    return;
  }
  const attendees = event.attendees ?? [];
  const weight = eventEngagementWeight(event.startMs, attendees.length, now);
  for (const a of attendees) {
    if (a.self || !a.email) {
      continue;
    }
    const email = a.email.trim().toLowerCase();
    if (!email) {
      continue;
    }
    const agg = byEmail.get(email) ?? { score: 0, meetingCount: 0 };
    agg.score += weight;
    agg.meetingCount += 1;
    if (event.startMs <= now) {
      agg.lastMetMs = Math.max(agg.lastMetMs ?? 0, event.startMs);
    } else {
      agg.nextMeetingMs = Math.min(agg.nextMeetingMs ?? Infinity, event.startMs);
    }
    byEmail.set(email, agg);
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
    // Prefix of by_user_and_calendar_and_end — the dedicated (userId, calendarId)
    // index was redundant with this one and was dropped to cut events index
    // storage. Order is irrelevant for a batch delete.
    .withIndex("by_user_and_calendar_and_end", (q) =>
      q.eq("userId", userId).eq("calendarId", googleCalendarId),
    )
    .take(EVENT_CLEANUP_BATCH_SIZE);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length === EVENT_CLEANUP_BATCH_SIZE;
}

// ---------------------------------------------------------------------------
// Sync orchestration (plain helpers run inside actions).
// ---------------------------------------------------------------------------
// How far back a full (first-time) resync reaches. Events older than this at
// sync time are never fetched. Matches EVENT_RETENTION_MS (maintenance.ts) so a
// first sync never fetches events the retention prune would immediately delete.
export const CALENDAR_HISTORY_MS = 180 * 24 * 60 * 60 * 1000;

// How far forward a full resync fetches. Without a bound, expanding an open-ended
// recurring series (singleEvents=true) can produce a very large — effectively
// unbounded — initial sync and store instances no view will ever show. A year
// comfortably exceeds the frontend's view ceiling; the retention prune trims any
// far-future instances that drift in past this horizon over time.
export const CALENDAR_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;

/** Returns whether any calendar produced event changes this run. */
async function syncCalendar(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
): Promise<boolean> {
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
  let changed = false;
  for (const cal of stored) {
    // Public calendars (holidays/birthdays) are identical for everyone, so their
    // events live once in `sharedEvents`, not per-user. Refresh the shared copy
    // on a cadence (any user's token can read a public calendar) instead of
    // syncing it into this user's `events`. `changed` stays false for these so a
    // shared refresh never triggers this user's engagement recompute.
    if (isSharedPublicCalendar(cal.googleCalendarId)) {
      await ensureSharedCalendarSynced(
        ctx,
        accessToken,
        cal.googleCalendarId,
        timeMinMs,
      );
      continue;
    }
    const calChanged = await syncOneCalendar(
      ctx,
      userId,
      accessToken,
      cal,
      timeMinMs,
    );
    changed = changed || calChanged;
  }
  return changed;
}

// How often a shared public calendar is re-fetched. Holidays/birthdays change
// rarely, so a daily refresh (by whichever user syncs first past the interval)
// is ample. The lease below caps concurrent refreshes to one.
const SHARED_CALENDAR_REFRESH_MS = 24 * 60 * 60 * 1000;
const SHARED_SYNC_LEASE_MS = 5 * 60 * 1000;

/**
 * Refresh a shared public calendar at most once per cadence, by at most one
 * user at a time. Reads the shared row, and if it is stale and unleased, claims
 * the lease and syncs into `sharedEvents`; otherwise returns immediately because
 * another user's sync already covered it. Best-effort: a failure here must never
 * fail the calling user's own calendar sync, so it swallows errors after logging.
 */
async function ensureSharedCalendarSynced(
  ctx: ActionCtx,
  accessToken: string,
  googleCalendarId: string,
  timeMinMs: number,
): Promise<void> {
  const claim = await ctx.runMutation(
    internal.googleSync.claimSharedCalendarSync,
    { googleCalendarId, refreshIntervalMs: SHARED_CALENDAR_REFRESH_MS },
  );
  if (!claim.claimed) {
    return;
  }
  try {
    await syncOneSharedCalendar(
      ctx,
      accessToken,
      { googleCalendarId, syncToken: claim.syncToken },
      timeMinMs,
    );
  } catch (err) {
    console.error(
      `Shared calendar sync failed for ${googleCalendarId}:`,
      err instanceof Error ? err.message : err,
    );
    await ctx.runMutation(internal.googleSync.releaseSharedCalendarLease, {
      googleCalendarId,
    });
  }
}

/**
 * The `sharedEvents` twin of `syncOneCalendar`: same incremental/full-resync
 * dance, but writing to the user-independent shared table and storing its cursor
 * on `sharedCalendars`. No people-harvest — a public calendar has no guests the
 * user knows.
 */
export async function syncOneSharedCalendar(
  ctx: ActionCtx,
  accessToken: string,
  cal: { googleCalendarId: string; syncToken?: string },
  timeMinMs: number,
): Promise<void> {
  let syncToken = cal.syncToken;
  let fullResync = !syncToken;
  let preparedForFullResync = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (fullResync && !preparedForFullResync) {
        let hasMore: boolean;
        do {
          hasMore = await ctx.runMutation(
            internal.googleSync.clearSharedCalendarEventsBatch,
            { googleCalendarId: cal.googleCalendarId },
          );
        } while (hasMore);
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
          await ctx.runMutation(internal.googleSync.upsertSharedEventsPage, {
            events: page.events,
          });
        }
        pageToken = page.nextPageToken;
        newSyncToken = page.nextSyncToken ?? newSyncToken;
      } while (pageToken);

      await ctx.runMutation(internal.googleSync.setSharedCalendarSynced, {
        googleCalendarId: cal.googleCalendarId,
        syncToken: newSyncToken,
      });
      return;
    } catch (err) {
      if (err instanceof SyncTokenExpiredError && attempt === 0) {
        fullResync = true;
        syncToken = undefined;
        preparedForFullResync = false;
        continue;
      }
      throw err;
    }
  }
}

/** Returns whether any events were written (upserted or cleared) — the caller
 * uses this to skip an engagement recompute when nothing on the calendar moved. */
export async function syncOneCalendar(
  ctx: ActionCtx,
  userId: string,
  accessToken: string,
  cal: { googleCalendarId: string; syncToken?: string },
  timeMinMs: number,
): Promise<boolean> {
  let syncToken = cal.syncToken;
  let fullResync = !syncToken;
  let changed = false;
  // Bound the forward horizon so an open-ended recurring series can't expand into
  // an effectively unbounded initial sync. Only applied on the full-resync path —
  // an incremental sync is driven by the sync token, which forbids timeMin/timeMax.
  const timeMaxMs = Date.now() + CALENDAR_FUTURE_MS;

  // Retry once: if the sync token is expired (410) we restart as a full resync.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // A full resync SWAPS the snapshot rather than clearing it first: it fetches
      // and upserts every current event stamped with a fresh generation, and only
      // once the new snapshot is fully written does it delete the rows still
      // carrying an older generation. The previous snapshot therefore stays live
      // for booking conflict detection throughout — a mid-run Google failure
      // leaves the old rows in place instead of blanking the calendar.
      let generation: number | undefined;
      if (fullResync) {
        generation = await ctx.runMutation(
          internal.googleSync.beginCalendarFullResync,
          { userId, googleCalendarId: cal.googleCalendarId },
        );
      }

      let pageToken: string | undefined;
      let newSyncToken: string | undefined;
      do {
        const page = await fetchCalendarPage(accessToken, {
          calendarId: cal.googleCalendarId,
          syncToken: fullResync ? undefined : syncToken,
          pageToken,
          timeMinMs: fullResync ? timeMinMs : undefined,
          timeMaxMs: fullResync ? timeMaxMs : undefined,
        });
        if (page.events.length > 0) {
          await ctx.runMutation(internal.googleSync.upsertEventsPage, {
            userId,
            events: page.events,
            syncGeneration: generation,
          });
          changed = true;
        }
        pageToken = page.nextPageToken;
        newSyncToken = page.nextSyncToken ?? newSyncToken;
      } while (pageToken);

      if (fullResync && generation !== undefined) {
        // New snapshot is complete. Sweep the previous generation's leftovers in
        // bounded batches, THEN persist the generation and token. Doing the sweep
        // before the commit means a crash mid-sweep leaves the token unset, so the
        // next run is another full resync that re-stamps and re-sweeps — the whole
        // swap is self-healing and never sets a token over a half-swept snapshot.
        let cursor: string | null = null;
        let done = false;
        while (!done) {
          const res: { cursor: string | null; done: boolean } =
            await ctx.runMutation(
              internal.googleSync.sweepStaleCalendarEventsBatch,
              {
                userId,
                googleCalendarId: cal.googleCalendarId,
                keepGeneration: generation,
                cursor,
              },
            );
          cursor = res.cursor;
          done = res.done;
        }
        await ctx.runMutation(internal.googleSync.commitCalendarFullResync, {
          userId,
          googleCalendarId: cal.googleCalendarId,
          syncGeneration: generation,
          syncToken: newSyncToken,
        });
        changed = true;
      } else if (newSyncToken) {
        await ctx.runMutation(internal.googleSync.setCalendarSyncToken, {
          userId,
          googleCalendarId: cal.googleCalendarId,
          syncToken: newSyncToken,
        });
      }
      return changed;
    } catch (err) {
      if (err instanceof SyncTokenExpiredError) {
        if (attempt === 1) {
          throw err;
        }
        fullResync = true;
        syncToken = undefined;
        continue;
      }
      throw err;
    }
  }
  return changed;
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
      // A full resync stamps every re-fetched connection with a fresh generation,
      // then sweeps those left behind — reconciling contacts (and their people
      // rows) that were deleted while the sync token was expired, which the People
      // API's incremental tombstones would otherwise never report.
      let generation: number | undefined;
      if (fullResync) {
        generation = await ctx.runMutation(
          internal.googleSync.beginContactsFullResync,
          { userId, feeder: "connection" },
        );
      }
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
            syncGeneration: generation,
          });
        }
        pageToken = page.nextPageToken;
        newSyncToken = page.nextSyncToken ?? newSyncToken;
      } while (pageToken);

      if (fullResync && generation !== undefined) {
        // Sweep first, then commit token+generation — a crash mid-sweep leaves the
        // token unset so the next run redoes the full resync (self-healing).
        let cursor: string | null = null;
        let done = false;
        while (!done) {
          const res: { cursor: string | null; done: boolean } =
            await ctx.runMutation(
              internal.googleSync.sweepStaleContactsBatch,
              { userId, keepGeneration: generation, cursor },
            );
          cursor = res.cursor;
          done = res.done;
        }
        await ctx.runMutation(internal.googleSync.setContactsSync, {
          userId,
          syncToken: newSyncToken,
          syncGeneration: generation,
        });
      } else if (newSyncToken) {
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
      // A full resync stamps every re-seen Other Contact's people row with a fresh
      // generation, then drops the "other" source from people it no longer sees —
      // reconciling auto-collected addresses removed while the token was expired.
      let generation: number | undefined;
      if (fullResync) {
        generation = await ctx.runMutation(
          internal.googleSync.beginContactsFullResync,
          { userId, feeder: "other" },
        );
      }
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
            syncGeneration: generation,
          });
        }
        pageToken = page.nextPageToken;
        newSyncToken = page.nextSyncToken ?? newSyncToken;
      } while (pageToken);

      if (fullResync && generation !== undefined) {
        let cursor: string | null = null;
        let done = false;
        while (!done) {
          const res: { cursor: string | null; done: boolean } =
            await ctx.runMutation(
              internal.googleSync.sweepStaleOtherPeopleBatch,
              { userId, keepGeneration: generation, cursor },
            );
          cursor = res.cursor;
          done = res.done;
        }
        await ctx.runMutation(internal.googleSync.setOtherContactsSync, {
          userId,
          syncToken: newSyncToken,
          syncGeneration: generation,
        });
      } else if (newSyncToken) {
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

async function runSyncForUser(
  ctx: ActionCtx,
  userId: string,
  initiatedByUser: boolean,
): Promise<void> {
  await ctx.runMutation(internal.googleSync.ensureSyncState, { userId });
  // Claim the per-user lease before touching Google. If another run (manual,
  // cron, or mount) already holds it, skip: a duplicate run would only race token
  // updates, and the in-flight run's results surface reactively anyway.
  const attemptId: string | null = await ctx.runMutation(
    internal.googleSync.claimSyncLease,
    { userId },
  );
  if (!attemptId) {
    return;
  }
  try {
    const accessToken = await getGoogleAccessToken(ctx, userId);
    const eventsChanged = await syncCalendar(ctx, userId, accessToken);
    await syncContacts(ctx, userId, accessToken);
    await syncOtherContacts(ctx, userId, accessToken);
    // Rank the people directory by how much the user actually meets each person.
    // Skip the full rescan+rewrite when no events moved this sync: scores only
    // shift on event changes (or as days pass — see the daily refresh cron), so
    // an unchanged calendar needs no work and leaves `people` untouched, keeping
    // the reactive listPeople query cached for connected clients.
    if (eventsChanged) {
      await recomputeEngagementForUser(ctx, userId);
    }
    // Set the next background poll and release the lease: reset to the floor when
    // the user is active (open app) or something changed; otherwise back off.
    await ctx.runMutation(internal.googleSync.recordSyncOutcome, {
      userId,
      attemptId,
      status: "idle",
      active: initiatedByUser || eventsChanged,
    });
  } catch (err) {
    await ctx.runMutation(internal.googleSync.recordSyncOutcome, {
      userId,
      attemptId,
      status: "error",
      lastError: err instanceof Error ? err.message : String(err),
      // A failed run shouldn't hammer Google; back off like an idle run.
      active: false,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public + internal Convex functions
// ---------------------------------------------------------------------------

/** Called by the authenticated client to register + sync the current user. */
/** Run the signed-in user's sync now, on the fast cadence. Shared by the
 * `googleSync.syncNow` compatibility action and the provider-neutral
 * `calendarSync.syncNow` facade so both trigger identical behavior. */
export async function syncNowForCurrentUser(ctx: ActionCtx): Promise<null> {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }
  // User-initiated: keep them on the fast cadence while the app is open.
  await runSyncForUser(ctx, user._id, true);
  return null;
}

export const syncNow = action({
  args: {},
  handler: (ctx): Promise<null> => syncNowForCurrentUser(ctx),
});

/** Per-user sync run, scheduled by the cron. */
export const syncUser = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    await runSyncForUser(ctx, args.userId, false);
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
 * `syncOneCalendar` on its full-resync path, which swaps in the fresh snapshot
 * under a new generation and only then sweeps the old rows — so the grid stays
 * populated throughout instead of blanking. */
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

/** Re-rank every user's people directory on a slow cadence so recency decay and
 * upcoming→past transitions settle even when a calendar sees no event changes.
 * Event-driven recompute (in runSyncForUser) handles the common case; this is
 * the safety net for idle calendars. */
export const enqueueEngagementRefresh = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db
      .query("syncState")
      .paginate({ cursor: args.cursor ?? null, numItems: SYNC_FANOUT_BATCH });
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

/** Fan out a sync for every user whose adaptive interval has elapsed (called by
 * the cron every 15 min). Only due users are scheduled, and the scan is
 * paginated + self-continued so the fan-out stays bounded at any user count. */
export const enqueueSyncs = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args): Promise<null> => {
    const now = Date.now();
    const page = await ctx.db
      .query("syncState")
      .withIndex("by_nextSyncDueAt", (q) => q.lte("nextSyncDueAt", now))
      .paginate({ cursor: args.cursor ?? null, numItems: SYNC_FANOUT_BATCH });
    for (const row of page.page) {
      // Pre-advance the due time as we schedule, so a run still in flight when the
      // next 15-min tick fires is not enqueued again. recordSyncOutcome resets it
      // to the real next value on completion; the per-user lease is the hard guard.
      await ctx.db.patch(row._id, {
        nextSyncDueAt: now + (row.syncIntervalMs ?? SYNC_MIN_MS),
      });
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
      await ctx.db.insert("syncState", {
        userId: args.userId,
        status: "idle",
        nextSyncDueAt: 0,
        syncIntervalMs: SYNC_MIN_MS,
      });
    } else if (existing.nextSyncDueAt === undefined) {
      // Lazily backfill cadence fields on rows created before adaptive sync.
      await ctx.db.patch(existing._id, {
        nextSyncDueAt: 0,
        syncIntervalMs: SYNC_MIN_MS,
      });
    }
    return null;
  },
});

/** Claim the per-user sync lease. Returns a fresh attempt id if the caller now
 * holds the lease, or `null` if a live run already holds it (a stale lease past
 * its expiry is reclaimable). The holder must pass the returned id back to
 * recordSyncOutcome to release it. Marks the row `syncing` on a successful claim. */
export const claimSyncLease = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const row = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!row) {
      return null;
    }
    const now = Date.now();
    if (row.syncAttemptId && (row.syncLeaseExpiresAt ?? 0) > now) {
      return null;
    }
    const attemptId = crypto.randomUUID();
    await ctx.db.patch(row._id, {
      status: "syncing",
      syncAttemptId: attemptId,
      syncLeaseExpiresAt: now + SYNC_LEASE_MS,
    });
    return attemptId;
  },
});

/** Finalize a sync run: schedule the next background poll and release the lease.
 * An `active` run (user-initiated, or something changed) resets the interval to
 * the floor; an idle run backs it off toward the cap so quiet users poll Google
 * far less often. No-op if the lease was reclaimed by a newer run (its attempt id
 * no longer matches), so a slow run can't clobber the run that superseded it. */
export const recordSyncOutcome = internalMutation({
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
    if (!row || row.syncAttemptId !== args.attemptId) {
      return null;
    }
    const prev = row.syncIntervalMs ?? SYNC_MIN_MS;
    const interval = args.active
      ? SYNC_MIN_MS
      : Math.min(prev * 2, SYNC_MAX_MS);
    await ctx.db.patch(row._id, {
      status: args.status,
      lastError: args.status === "error" ? args.lastError : undefined,
      syncIntervalMs: interval,
      nextSyncDueAt: Date.now() + interval,
      syncAttemptId: undefined,
      syncLeaseExpiresAt: undefined,
    });
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
/** Reserve the generation a full resync will stamp its rows with, without
 * persisting it. Returns one past the calendar's current generation. Not
 * persisted here so a crashed resync simply reuses the same number next time
 * (re-stamping present events with it is idempotent). Committed only once the new
 * snapshot is complete, in `commitCalendarFullResync`. */
export const beginCalendarFullResync = internalMutation({
  args: { userId: v.string(), googleCalendarId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const row = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (q) =>
        q.eq("userId", args.userId).eq("googleCalendarId", args.googleCalendarId),
      )
      .unique();
    return (row?.syncGeneration ?? 0) + 1;
  },
});

/** Delete one bounded batch of a calendar's `events` rows whose generation is not
 * `keepGeneration` (i.e. leftovers from the previous full-resync snapshot). Walks
 * the (userId, calendarId) prefix by cursor so kept rows are skipped exactly once
 * and the sweep always terminates. Returns the next cursor and whether it's done. */
export const sweepStaleCalendarEventsBatch = internalMutation({
  args: {
    userId: v.string(),
    googleCalendarId: v.string(),
    keepGeneration: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ cursor: string | null; done: boolean }> => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_user_and_calendar_and_end", (q) =>
        q.eq("userId", args.userId).eq("calendarId", args.googleCalendarId),
      )
      .paginate({ cursor: args.cursor, numItems: EVENT_CLEANUP_BATCH_SIZE });
    for (const row of page.page) {
      if (row.syncGeneration !== args.keepGeneration) {
        await ctx.db.delete(row._id);
      }
    }
    return { cursor: page.continueCursor, done: page.isDone };
  },
});

/** Persist the completed full-resync generation (and the fresh sync token, when
 * Google returned one) on the calendar. Called only after the new snapshot is
 * fully written and the previous generation swept. */
export const commitCalendarFullResync = internalMutation({
  args: {
    userId: v.string(),
    googleCalendarId: v.string(),
    syncGeneration: v.number(),
    syncToken: v.optional(v.string()),
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
        syncGeneration: args.syncGeneration,
        ...(args.syncToken !== undefined
          ? { syncToken: args.syncToken, lastSyncAt: Date.now() }
          : {}),
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

// --- Shared public-calendar sync state ------------------------------------

const SHARED_EVENT_CLEANUP_BATCH_SIZE = EVENT_CLEANUP_BATCH_SIZE;

async function deleteSharedCalendarEventsBatch(
  ctx: MutationCtx,
  googleCalendarId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .query("sharedEvents")
    .withIndex("by_calendar_and_start", (q) =>
      q.eq("calendarId", googleCalendarId),
    )
    .take(SHARED_EVENT_CLEANUP_BATCH_SIZE);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length === SHARED_EVENT_CLEANUP_BATCH_SIZE;
}

/**
 * Claim the right to refresh a shared calendar. Returns `claimed: true` (with
 * the current sync token) only when the calendar is due for a refresh and not
 * already leased by another in-flight sync; otherwise `claimed: false`. Creates
 * the `sharedCalendars` row on first sight. This is the transaction that makes
 * "synced once, by one user" true.
 */
export const claimSharedCalendarSync = internalMutation({
  args: { googleCalendarId: v.string(), refreshIntervalMs: v.number() },
  returns: v.object({
    claimed: v.boolean(),
    syncToken: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db
      .query("sharedCalendars")
      .withIndex("by_googleCalendarId", (q) =>
        q.eq("googleCalendarId", args.googleCalendarId),
      )
      .unique();
    if (!row) {
      await ctx.db.insert("sharedCalendars", {
        googleCalendarId: args.googleCalendarId,
        syncLeaseExpiresAt: now + SHARED_SYNC_LEASE_MS,
      });
      return { claimed: true, syncToken: undefined };
    }
    const leaseLive =
      row.syncLeaseExpiresAt !== undefined && row.syncLeaseExpiresAt > now;
    const fresh =
      row.lastSyncAt !== undefined &&
      now - row.lastSyncAt < args.refreshIntervalMs;
    if (leaseLive || fresh) {
      return { claimed: false, syncToken: row.syncToken };
    }
    await ctx.db.patch(row._id, { syncLeaseExpiresAt: now + SHARED_SYNC_LEASE_MS });
    return { claimed: true, syncToken: row.syncToken };
  },
});

export const releaseSharedCalendarLease = internalMutation({
  args: { googleCalendarId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("sharedCalendars")
      .withIndex("by_googleCalendarId", (q) =>
        q.eq("googleCalendarId", args.googleCalendarId),
      )
      .unique();
    if (row) {
      await ctx.db.patch(row._id, { syncLeaseExpiresAt: undefined });
    }
    return null;
  },
});

export const clearSharedCalendarEventsBatch = internalMutation({
  args: { googleCalendarId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    return await deleteSharedCalendarEventsBatch(ctx, args.googleCalendarId);
  },
});

/** Record a completed shared sync: store the new cursor, stamp the refresh time,
 * and drop the lease. Called on the success path of syncOneSharedCalendar. */
export const setSharedCalendarSynced = internalMutation({
  args: {
    googleCalendarId: v.string(),
    syncToken: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("sharedCalendars")
      .withIndex("by_googleCalendarId", (q) =>
        q.eq("googleCalendarId", args.googleCalendarId),
      )
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        // A full resync returns no token on its first page set; keep the old one
        // rather than clearing a still-valid cursor.
        syncToken: args.syncToken ?? row.syncToken,
        lastSyncAt: Date.now(),
        syncLeaseExpiresAt: undefined,
      });
    }
    return null;
  },
});

/** The `sharedEvents` twin of `upsertEventsPage`: keyed by (calendarId,
 * googleEventId), no `userId`, no people harvest. */
export const upsertSharedEventsPage = internalMutation({
  args: { events: v.array(googleEventValidator) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    for (const e of args.events) {
      const existing = await ctx.db
        .query("sharedEvents")
        .withIndex("by_calendar_and_googleEventId", (q) =>
          q.eq("calendarId", e.calendarId).eq("googleEventId", e.googleEventId),
        )
        .unique();
      if (e.status === "cancelled") {
        if (existing) {
          await ctx.db.delete(existing._id);
        }
        continue;
      }
      if (existing) {
        await ctx.db.replace(existing._id, { ...e });
      } else {
        await ctx.db.insert("sharedEvents", { ...e });
      }
    }
    return null;
  },
});

export const setContactsSync = internalMutation({
  args: {
    userId: v.string(),
    syncToken: v.optional(v.string()),
    // Persisted on a full-resync commit so the next full resync bumps past it.
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        ...(args.syncToken !== undefined
          ? { contactsSyncToken: args.syncToken, lastContactsSyncAt: Date.now() }
          : {}),
        ...(args.syncGeneration !== undefined
          ? { contactsSyncGeneration: args.syncGeneration }
          : {}),
      });
    }
    return null;
  },
});

export const setOtherContactsSync = internalMutation({
  args: {
    userId: v.string(),
    syncToken: v.optional(v.string()),
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        ...(args.syncToken !== undefined
          ? {
              otherContactsSyncToken: args.syncToken,
              lastOtherContactsSyncAt: Date.now(),
            }
          : {}),
        ...(args.syncGeneration !== undefined
          ? { otherContactsSyncGeneration: args.syncGeneration }
          : {}),
      });
    }
    return null;
  },
});

/** Reserve the next full-resync generation for one contact feeder without
 * persisting it (persisted on commit via set{Contacts,OtherContacts}Sync). A
 * crashed resync reuses the same number next time, which is safe: re-stamping the
 * present records with it is idempotent and the sweep keeps exactly that set. */
export const beginContactsFullResync = internalMutation({
  args: {
    userId: v.string(),
    feeder: v.union(v.literal("connection"), v.literal("other")),
  },
  handler: async (ctx, args): Promise<number> => {
    const row = await ctx.db
      .query("syncState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    const current =
      args.feeder === "connection"
        ? row?.contactsSyncGeneration
        : row?.otherContactsSyncGeneration;
    return (current ?? 0) + 1;
  },
});

/** Delete one bounded batch of the user's `contacts` whose generation is not
 * `keepGeneration` (connections absent from the latest full snapshot), cascading
 * each into the people directory. Cursor-walked so it always terminates. */
export const sweepStaleContactsBatch = internalMutation({
  args: {
    userId: v.string(),
    keepGeneration: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ cursor: string | null; done: boolean }> => {
    const page = await ctx.db
      .query("contacts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: EVENT_CLEANUP_BATCH_SIZE });
    for (const row of page.page) {
      if (row.syncGeneration !== args.keepGeneration) {
        for (const email of row.emails) {
          await removePersonSource(ctx, args.userId, email, "connection");
        }
        await ctx.db.delete(row._id);
      }
    }
    return { cursor: page.continueCursor, done: page.isDone };
  },
});

/** Drop the "other" source from one bounded batch of people whose Other Contacts
 * generation is stale (they weren't in the latest full snapshot). The person row
 * is deleted only if "other" was its last source. */
export const sweepStaleOtherPeopleBatch = internalMutation({
  args: {
    userId: v.string(),
    keepGeneration: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ cursor: string | null; done: boolean }> => {
    const page = await ctx.db
      .query("people")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .paginate({ cursor: args.cursor, numItems: EVENT_CLEANUP_BATCH_SIZE });
    for (const row of page.page) {
      if (
        row.sources.includes("other") &&
        row.otherSyncGeneration !== args.keepGeneration
      ) {
        const sources = row.sources.filter((s) => s !== "other");
        if (sources.length === 0) {
          await ctx.db.delete(row._id);
        } else {
          await ctx.db.patch(row._id, { sources, updatedAt: Date.now() });
        }
      }
    }
    return { cursor: page.continueCursor, done: page.isDone };
  },
});

export const upsertEventsPage = internalMutation({
  args: {
    userId: v.string(),
    events: v.array(googleEventValidator),
    // Set on the full-resync path so re-fetched rows carry the new generation
    // and survive the sweep. Omitted on incremental writes (see eventDocValidator).
    syncGeneration: v.optional(v.number()),
  },
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
        await ctx.db.replace(existing._id, {
          userId: args.userId,
          ...e,
          syncGeneration: args.syncGeneration,
        });
      } else {
        await ctx.db.insert("events", {
          userId: args.userId,
          ...e,
          syncGeneration: args.syncGeneration,
        });
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
  args: {
    userId: v.string(),
    contacts: v.array(contactValidator),
    // Set on the full-resync path so re-fetched contacts carry the new generation
    // and survive the sweep; omitted (and preserved) on incremental writes.
    syncGeneration: v.optional(v.number()),
  },
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
          // Cascade the tombstone into the people directory before removing the
          // contact, so its saved name/photo can't linger there as an orphan.
          for (const email of existing.emails) {
            await removePersonSource(ctx, args.userId, email, "connection");
          }
          await ctx.db.delete(existing._id);
        }
        continue;
      }
      const { deleted: _deleted, ...rest } = c;
      const stampGen =
        args.syncGeneration !== undefined
          ? { syncGeneration: args.syncGeneration }
          : {};
      if (existing) {
        await ctx.db.patch(existing._id, { ...rest, ...stampGen });
      } else {
        await ctx.db.insert("contacts", {
          userId: args.userId,
          ...rest,
          ...stampGen,
        });
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
  args: {
    userId: v.string(),
    contacts: v.array(contactValidator),
    // Set on the full-resync path so touched people carry the new "other"
    // generation and survive the sweep; omitted (preserved) on incremental.
    syncGeneration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    // Other Contacts have no backing table, so a tombstone can only be cascaded
    // straight into the people directory by dropping the "other" source.
    for (const c of args.contacts) {
      if (c.deleted) {
        for (const email of c.emails) {
          await removePersonSource(ctx, args.userId, email, "other");
        }
      }
    }
    await upsertPeopleRows(
      ctx,
      args.userId,
      "other",
      contactsToPeople(args.contacts),
      args.syncGeneration,
    );
    return null;
  },
});

/** A page of events trimmed to just what engagement scoring reads. Keeping the
 * projection narrow keeps the action's bytes-read bounded on large calendars. */
type EngagementEventPage = {
  page: {
    startMs: number;
    status: string;
    attendees?: { email: string; self?: boolean }[];
  }[];
  isDone: boolean;
  continueCursor: string;
};

export const listEventsPageForEngagement = internalQuery({
  args: {
    userId: v.string(),
    sinceMs: v.number(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args): Promise<EngagementEventPage> => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_user_and_start", (q) =>
        q.eq("userId", args.userId).gte("startMs", args.sinceMs),
      )
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    return {
      page: page.page.map((e) => ({
        startMs: e.startMs,
        status: e.status,
        attendees: e.attendees,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const applyEngagementScores = internalMutation({
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
    const now = Date.now();
    for (const s of args.scores) {
      const row = await ctx.db
        .query("people")
        .withIndex("by_user_and_email", (q) =>
          q.eq("userId", args.userId).eq("email", s.email),
        )
        .unique();
      if (row) {
        await ctx.db.patch(row._id, {
          score: s.score,
          meetingCount: s.meetingCount,
          lastMetMs: s.lastMetMs,
          nextMeetingMs: s.nextMeetingMs,
          updatedAt: now,
        });
      }
    }
    return null;
  },
});

/** Recompute every known person's engagement score from the user's events and
 * write it back onto their `people` row. Reads events in pages and aggregates in
 * the action (the recency decay needs the wall clock), then flushes scores in
 * bounded mutation batches. Idempotent — a re-run overwrites, never accumulates.
 */
async function recomputeEngagementForUser(
  ctx: ActionCtx,
  userId: string,
): Promise<void> {
  const now = Date.now();
  const sinceMs = now - ENGAGEMENT_WINDOW_MS;
  const byEmail = new Map<string, Engagement>();
  let cursor: string | null = null;
  for (;;) {
    const page: EngagementEventPage = await ctx.runQuery(
      internal.googleSync.listEventsPageForEngagement,
      { userId, sinceMs, cursor, numItems: 200 },
    );
    for (const e of page.page) {
      accumulateEventEngagement(byEmail, e, now);
    }
    if (page.isDone) {
      break;
    }
    cursor = page.continueCursor;
  }

  const scores = [...byEmail.entries()].map(([email, agg]) => ({
    email,
    score: agg.score,
    meetingCount: agg.meetingCount,
    lastMetMs: agg.lastMetMs,
    nextMeetingMs: agg.nextMeetingMs,
  }));
  const BATCH = 200;
  for (let i = 0; i < scores.length; i += BATCH) {
    await ctx.runMutation(internal.googleSync.applyEngagementScores, {
      userId,
      scores: scores.slice(i, i + BATCH),
    });
  }
}

/** Standalone entry point for engagement recompute (dashboard / backfill). The
 * sync path calls the helper directly. */
export const recomputeEngagement = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    await recomputeEngagementForUser(ctx, args.userId);
    return null;
  },
});
