/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { ProviderError } from "../../integrations/calendar/errors";
import { getContactsAdapter } from "../../integrations/calendar/registry";
import type {
  CalendarProviderAdapter,
  PageCursor,
  ProviderCalendar,
  ProviderEvent,
  SyncCursor,
  SyncPage,
} from "../../integrations/calendar/types";
import schema from "../../schema";
import {
  chunkEngagementScores,
  summarizeConnectionSyncs,
  syncOneConnectionCalendar,
  syncSharedCalendar,
} from "./engine";

import { modules } from "../../../testModules";

function event(id: string, calendarId = "calendar"): ProviderEvent {
  return {
    id,
    calendarId,
    startMs: 1_000,
    endMs: 2_000,
    allDay: false,
    status: "confirmed",
    updatedMs: 1_000,
  };
}

class FakeCalendarAdapter implements CalendarProviderAdapter {
  readonly provider = "microsoft" as const;
  readonly capabilities = {
    contacts: false,
    recurringEvents: true,
    attendeeMembershipUpdates: true,
    rsvp: true,
    removeSelf: true,
    conference: { create: false, add: false, remove: false },
    idempotentCreate: true,
    idempotentUpdate: true,
    idempotentResponse: true,
    idempotentDelete: true,
  };
  readonly calls: { syncCursor: SyncCursor | null; pageCursor?: PageCursor | null }[] = [];

  constructor(
    private readonly pages: (
      | SyncPage<ProviderEvent>
      | Error
      | ((call: number) => SyncPage<ProviderEvent> | Error)
    )[],
  ) {}

  async listCalendars(): Promise<readonly ProviderCalendar[]> {
    return [];
  }

  async listEvents(args: {
    calendarId: string;
    syncCursor: SyncCursor | null;
    pageCursor?: PageCursor | null;
    fromMs: number;
    toMs: number;
  }): Promise<SyncPage<ProviderEvent>> {
    this.calls.push({
      syncCursor: args.syncCursor,
      pageCursor: args.pageCursor,
    });
    const configured = this.pages.shift();
    const result =
      typeof configured === "function"
        ? configured(this.calls.length)
        : configured;
    if (!result) throw new Error("Unexpected fake-provider page request");
    if (result instanceof Error) throw result;
    return result;
  }

  async getEvent(): Promise<ProviderEvent> {
    throw new Error("not used");
  }
  async createEvent(): Promise<ProviderEvent> {
    throw new Error("not used");
  }
  async reconcileAmbiguousCreate(): Promise<ProviderEvent | null> {
    return null;
  }
  async updateEvent(): Promise<ProviderEvent> {
    throw new Error("not used");
  }
  async respondToEvent(): Promise<ProviderEvent> {
    throw new Error("not used");
  }
  async deleteEvent(): Promise<void> {
    throw new Error("not used");
  }
}

async function setupConnection(
  t: ReturnType<typeof convexTest>,
  userId: string,
  provider: "google" | "microsoft" = "microsoft",
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const connectionId = await ctx.db.insert("calendarConnections", {
      userId,
      provider,
      status: "active",
      capabilities: { contacts: true, idempotentCreate: true },
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("connectionSyncState", {
      connectionId,
      userId,
      status: "idle",
      nextSyncDueAt: 0,
      syncIntervalMs: 15 * 60 * 1_000,
    });
    return connectionId;
  });
}

async function setupCalendar(
  t: ReturnType<typeof convexTest>,
  userId: string,
  connectionId: Id<"calendarConnections">,
  providerCalendarId = "calendar",
  syncCursor?: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("calendars", {
      userId,
      googleCalendarId: providerCalendarId,
      selected: true,
      connectionId,
      providerCalendarId,
      syncCursor,
      syncToken: syncCursor,
    }),
  );
}

function testActionCtx(t: ReturnType<typeof convexTest>): ActionCtx {
  return {
    runMutation: (reference, args) => t.mutation(reference, args),
    runQuery: (reference, args) => t.query(reference, args),
  } as ActionCtx;
}

describe("connection-scoped fake-provider sync", () => {
  test("uses separate committed and page cursors and commits only after the final page", async () => {
    const t = convexTest(schema, modules);
    const userId = "cursor-user";
    const connectionId = await setupConnection(t, userId);
    const calendarId = await setupCalendar(
      t,
      userId,
      connectionId,
      "calendar",
      "committed-old",
    );
    const attemptId = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId,
    });
    const adapter = new FakeCalendarAdapter([
      {
        items: [event("one")],
        nextPageCursor: "page-2" as PageCursor,
        commitCursor: null,
      },
      {
        items: [event("two")],
        nextPageCursor: null,
        commitCursor: "committed-new" as SyncCursor,
      },
    ]);

    await syncOneConnectionCalendar(testActionCtx(t), adapter, {
      connectionId,
      attemptId: attemptId!,
      localCalendarId: calendarId,
      providerCalendarId: "calendar",
      syncCursor: "committed-old",
    });

    expect(adapter.calls).toEqual([
      { syncCursor: "committed-old", pageCursor: null },
      { syncCursor: "committed-old", pageCursor: "page-2" },
    ]);
    const calendar = await t.run((ctx) => ctx.db.get(calendarId));
    expect(calendar?.syncCursor).toBe("committed-new");
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("events")
          .withIndex("by_user_and_calendar_and_end", (q) =>
            q.eq("userId", userId).eq("calendarId", "calendar"),
          )
          .collect(),
      ),
    ).toHaveLength(2);
  });

  test("keeps the previous snapshot available when a full refresh fails mid-pass", async () => {
    const t = convexTest(schema, modules);
    const userId = "snapshot-user";
    const connectionId = await setupConnection(t, userId);
    const calendarId = await setupCalendar(t, userId, connectionId);
    await t.run(async (ctx) => {
      await ctx.db.patch(calendarId, { syncGeneration: 1 });
      await ctx.db.insert("events", {
        userId,
        googleEventId: "old",
        calendarId: "calendar",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 1_000,
        syncGeneration: 1,
        connectionId,
        localCalendarId: calendarId,
        providerEventId: "old",
        providerUpdatedMs: 1_000,
      });
    });
    const attemptId = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId,
    });
    const adapter = new FakeCalendarAdapter([
      {
        items: [
          event("abandoned"),
          { ...event("old"), status: "cancelled" },
        ],
        nextPageCursor: "next" as PageCursor,
        commitCursor: null,
      },
      new Error("provider unavailable"),
    ]);

    await expect(
      syncOneConnectionCalendar(testActionCtx(t), adapter, {
        connectionId,
        attemptId: attemptId!,
        localCalendarId: calendarId,
        providerCalendarId: "calendar",
      }),
    ).rejects.toThrow("provider unavailable");
    const ids = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("events")
          .withIndex("by_user_and_calendar_and_end", (q) =>
            q.eq("userId", userId).eq("calendarId", "calendar"),
          )
          .collect()
      ).map((row) => row.providerEventId).sort(),
    );
    expect(ids).toEqual(["abandoned", "old"]);
    expect((await t.run((ctx) => ctx.db.get(calendarId)))?.syncCursor).toBeUndefined();

    await t.run(async (ctx) => {
      const state = await ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
        .unique();
      await ctx.db.patch(state!._id, { syncLeaseExpiresAt: Date.now() - 1 });
    });
    const nextAttemptId = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId,
    });
    await syncOneConnectionCalendar(
      testActionCtx(t),
      new FakeCalendarAdapter([
        {
          items: [event("fresh")],
          nextPageCursor: null,
          commitCursor: "snapshot-complete" as SyncCursor,
        },
      ]),
      {
        connectionId,
        attemptId: nextAttemptId!,
        localCalendarId: calendarId,
        providerCalendarId: "calendar",
      },
    );
    expect(
      await t.run(async (ctx) =>
        (
          await ctx.db
            .query("events")
            .withIndex("by_user_and_calendar_and_end", (q) =>
              q.eq("userId", userId).eq("calendarId", "calendar"),
            )
            .collect()
        ).map((row) => row.providerEventId),
      ),
    ).toEqual(["fresh"]);
    expect((await t.run((ctx) => ctx.db.get(calendarId)))?.syncGeneration).toBe(3);
  });

  test("falls back to a bounded full pass when the committed cursor expires", async () => {
    const t = convexTest(schema, modules);
    const userId = "expiry-user";
    const connectionId = await setupConnection(t, userId);
    const calendarId = await setupCalendar(
      t,
      userId,
      connectionId,
      "calendar",
      "expired",
    );
    const attemptId = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId,
    });
    const adapter = new FakeCalendarAdapter([
      new ProviderError("cursor-expired", "expired"),
      {
        items: [event("fresh")],
        nextPageCursor: null,
        commitCursor: "fresh-cursor" as SyncCursor,
      },
    ]);

    await syncOneConnectionCalendar(testActionCtx(t), adapter, {
      connectionId,
      attemptId: attemptId!,
      localCalendarId: calendarId,
      providerCalendarId: "calendar",
      syncCursor: "expired",
    });
    expect(adapter.calls.map((call) => call.syncCursor)).toEqual(["expired", null]);
    expect((await t.run((ctx) => ctx.db.get(calendarId)))?.syncCursor).toBe(
      "fresh-cursor",
    );
  });
});

describe("connection identity and lease fencing", () => {
  test("calendar and event reconciliation repair legacy rows before inserting", async () => {
    const t = convexTest(schema, modules);
    const userId = "legacy-reconcile";
    const connectionId = await setupConnection(t, userId, "google");
    const calendarId = await t.run(async (ctx) => {
      const calendarId = await ctx.db.insert("calendars", {
        userId,
        googleCalendarId: "legacy-calendar",
        summary: "Old",
        summaryOverride: "Stale override",
        selected: true,
      });
      await ctx.db.insert("events", {
        userId,
        googleEventId: "legacy-event",
        calendarId: "legacy-calendar",
        startMs: 1,
        endMs: 2,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 1,
      });
      return calendarId;
    });
    const attemptId = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId,
    });
    const reconciled = await t.mutation(
      internal.domains.sync.engine.reconcileCalendars,
      {
        connectionId,
        attemptId: attemptId!,
        calendars: [
          {
            id: "legacy-calendar",
            summary: "Provider name",
            writable: true,
          },
        ],
      },
    );
    expect(reconciled[0]?.localCalendarId).toBe(calendarId);
    await t.mutation(internal.domains.sync.engine.upsertEventsPage, {
      connectionId,
      attemptId: attemptId!,
      localCalendarId: calendarId,
      events: [
        {
          ...event("legacy-event", "legacy-calendar"),
          color: "7",
          busy: false,
        },
      ],
    });
    const state = await t.run(async (ctx) => ({
      calendars: await ctx.db.query("calendars").collect(),
      events: await ctx.db.query("events").collect(),
    }));
    expect(state.calendars).toHaveLength(1);
    expect(state.calendars[0]).toMatchObject({
      connectionId,
      providerCalendarId: "legacy-calendar",
      summary: "Provider name",
    });
    expect(state.calendars[0]?.summaryOverride).toBeUndefined();
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      connectionId,
      localCalendarId: calendarId,
      providerEventId: "legacy-event",
      color: "7",
      busy: false,
    });
  });

  test("allows colliding provider ids on independent connections", async () => {
    const t = convexTest(schema, modules);
    const userId = "collision-user";
    const first = await setupConnection(t, userId);
    const second = await setupConnection(t, userId);
    const firstCalendar = await setupCalendar(t, userId, first, "same-calendar");
    const secondCalendar = await setupCalendar(t, userId, second, "same-calendar");
    const firstAttempt = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId: first,
    });
    const secondAttempt = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId: second,
    });
    for (const [connectionId, localCalendarId, attemptId] of [
      [first, firstCalendar, firstAttempt],
      [second, secondCalendar, secondAttempt],
    ] as const) {
      expect(
        await t.mutation(internal.domains.sync.engine.upsertEventsPage, {
          connectionId,
          attemptId: attemptId!,
          localCalendarId,
          events: [event("same-event", "same-calendar")],
        }),
      ).toBe(true);
    }
    const rows = await t.run((ctx) => ctx.db.query("events").collect());
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.connectionId)).size).toBe(2);
  });

  test("a reclaimed attempt cannot write a page, commit a cursor, or release", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await setupConnection(t, "fence-user");
    const calendarId = await setupCalendar(t, "fence-user", connectionId);
    const stale = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId,
    });
    await t.run(async (ctx) => {
      const state = await ctx.db
        .query("connectionSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
        .unique();
      await ctx.db.patch(state!._id, { syncLeaseExpiresAt: Date.now() - 1 });
    });
    const current = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId,
    });
    expect(current).not.toBe(stale);
    expect(
      await t.mutation(internal.domains.sync.engine.upsertEventsPage, {
        connectionId,
        attemptId: stale!,
        localCalendarId: calendarId,
        events: [event("stale")],
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.domains.sync.engine.setCalendarSyncCursor, {
        connectionId,
        attemptId: stale!,
        localCalendarId: calendarId,
        syncCursor: "stale",
      }),
    ).toBe(false);
    await t.mutation(internal.domains.sync.engine.recordSyncOutcome, {
      connectionId,
      attemptId: stale!,
      status: "idle",
      active: false,
    });
    expect(
      await t.mutation(internal.domains.sync.engine.claimSyncLease, { connectionId }),
    ).toBeNull();
  });

  test("an error on one connection does not alter another connection's cadence", async () => {
    const t = convexTest(schema, modules);
    const first = await setupConnection(t, "partial-user");
    const second = await setupConnection(t, "partial-user");
    const firstAttempt = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId: first,
    });
    const secondAttempt = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId: second,
    });
    await t.mutation(internal.domains.sync.engine.recordSyncOutcome, {
      connectionId: first,
      attemptId: firstAttempt!,
      status: "error",
      lastError: "failed",
      active: false,
    });
    await t.mutation(internal.domains.sync.engine.recordSyncOutcome, {
      connectionId: second,
      attemptId: secondAttempt!,
      status: "idle",
      active: true,
    });
    const states = await t.run((ctx) => ctx.db.query("connectionSyncState").collect());
    expect(states.find((row) => row.connectionId === first)?.status).toBe("error");
    expect(states.find((row) => row.connectionId === second)?.status).toBe("idle");
  });

  test("removed-calendar cleanup drains events and recurring series", async () => {
    const t = convexTest(schema, modules);
    const userId = "removed-calendar-user";
    const connectionId = await setupConnection(t, userId, "google");
    const calendarId = await setupCalendar(
      t,
      userId,
      connectionId,
      "removed",
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        userId,
        googleEventId: "event",
        calendarId: "removed",
        startMs: 1,
        endMs: 2,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 1,
      });
      await ctx.db.insert("recurringSeries", {
        userId,
        calendarId: "removed",
        googleEventId: "series",
        recurrence: ["RRULE:FREQ=DAILY"],
        sourceUpdatedMs: 1,
      });
      await ctx.db.delete(calendarId);
    });
    await t.mutation(internal.domains.sync.engine.cleanupRemovedCalendarEvents, {
      connectionId,
      localCalendarId: calendarId,
      providerCalendarId: "removed",
    });
    expect(await t.run((ctx) => ctx.db.query("events").collect())).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("recurringSeries").collect()),
    ).toHaveLength(0);
  });
});

describe("connection-aware contact ownership", () => {
  test("a provider without the contacts capability is skipped", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await setupConnection(t, "no-contacts-user");
    await t.run((ctx) =>
      ctx.db.patch(connectionId, {
        capabilities: { contacts: false, idempotentCreate: true },
      }),
    );
    expect(await getContactsAdapter(testActionCtx(t), connectionId)).toBeNull();
  });

  test("removing one connection's contact keeps another claim for the same email", async () => {
    const t = convexTest(schema, modules);
    const userId = "contact-user";
    const first = await setupConnection(t, userId);
    const second = await setupConnection(t, userId);
    const firstAttempt = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId: first,
    });
    const secondAttempt = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId: second,
    });
    for (const [connectionId, attemptId, id] of [
      [first, firstAttempt, "first"],
      [second, secondAttempt, "second"],
    ] as const) {
      await t.mutation(internal.domains.sync.engine.upsertContactsPage, {
        connectionId,
        attemptId: attemptId!,
        feed: "contacts",
        contacts: [
          {
            id,
            deleted: false,
            emails: ["same@example.com"],
            phones: [],
          },
        ],
      });
    }
    await t.mutation(internal.domains.sync.engine.upsertContactsPage, {
      connectionId: first,
      attemptId: firstAttempt!,
      feed: "contacts",
      contacts: [
        { id: "first", deleted: true, emails: [], phones: [] },
      ],
    });
    const person = await t.run((ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_user_and_email", (q) =>
          q.eq("userId", userId).eq("email", "same@example.com"),
        )
        .unique(),
    );
    expect(person?.sources).toContain("connection");
    expect(await t.run((ctx) => ctx.db.query("personSourceClaims").collect())).toHaveLength(1);
  });

  test("two provider contacts sharing one email retain independent claims", async () => {
    const t = convexTest(schema, modules);
    const userId = "shared-email-user";
    const connectionId = await setupConnection(t, userId, "google");
    const attemptId = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId,
    });
    await t.mutation(internal.domains.sync.engine.upsertContactsPage, {
      connectionId,
      attemptId: attemptId!,
      feed: "other",
      contacts: ["people/one", "people/two"].map((id) => ({
        id,
        deleted: false,
        emails: ["shared@example.com"],
        phones: [],
      })),
    });
    expect(
      await t.run((ctx) => ctx.db.query("personSourceClaims").collect()),
    ).toHaveLength(2);
    await t.mutation(internal.domains.sync.engine.upsertContactsPage, {
      connectionId,
      attemptId: attemptId!,
      feed: "other",
      contacts: [
        { id: "people/one", deleted: true, emails: [], phones: [] },
      ],
    });
    const claims = await t.run((ctx) =>
      ctx.db.query("personSourceClaims").collect(),
    );
    expect(claims.map((row) => row.providerContactId)).toEqual(["people/two"]);
    const person = await t.run((ctx) =>
      ctx.db
        .query("people")
        .withIndex("by_user_and_email", (q) =>
          q.eq("userId", userId).eq("email", "shared@example.com"),
        )
        .unique(),
    );
    expect(person?.sources).toContain("other");
  });

  test("new contact-feed attempts reserve new generations and sweep abandoned rows", async () => {
    for (const feed of ["contacts", "other"] as const) {
      const t = convexTest(schema, modules);
      const userId = `crash-${feed}`;
      const connectionId = await setupConnection(t, userId, "google");
      const first = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
        connectionId,
      });
      const firstGeneration = await t.mutation(
        internal.domains.sync.engine.beginContactsFullResync,
        { connectionId, attemptId: first!, feed },
      );
      await t.mutation(internal.domains.sync.engine.upsertContactsPage, {
        connectionId,
        attemptId: first!,
        feed,
        syncGeneration: firstGeneration!,
        contacts: [
          {
            id: "abandoned",
            deleted: false,
            emails: [`abandoned-${feed}@example.com`],
            phones: [],
          },
        ],
      });
      await t.run(async (ctx) => {
        const state = await ctx.db
          .query("connectionSyncState")
          .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
          .unique();
        await ctx.db.patch(state!._id, { syncLeaseExpiresAt: Date.now() - 1 });
      });
      const second = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
        connectionId,
      });
      const secondGeneration = await t.mutation(
        internal.domains.sync.engine.beginContactsFullResync,
        { connectionId, attemptId: second!, feed },
      );
      expect(secondGeneration).toBe(firstGeneration! + 1);
      await t.mutation(internal.domains.sync.engine.upsertContactsPage, {
        connectionId,
        attemptId: second!,
        feed,
        syncGeneration: secondGeneration!,
        contacts: [
          {
            id: "current",
            deleted: false,
            emails: [`current-${feed}@example.com`],
            phones: [],
          },
        ],
      });
      await t.mutation(internal.domains.sync.engine.sweepStaleContactsBatch, {
        connectionId,
        attemptId: second!,
        feed,
        keepGeneration: secondGeneration!,
        cursor: null,
      });
      const rows = await t.run(async (ctx) =>
        feed === "contacts"
          ? await ctx.db.query("contacts").collect()
          : await ctx.db.query("otherContactSources").collect(),
      );
      expect(rows.map((row) => row.providerContactId)).toEqual(["current"]);
      const claims = await t.run((ctx) =>
        ctx.db.query("personSourceClaims").collect(),
      );
      expect(claims.map((row) => row.providerContactId)).toEqual(["current"]);
    }
  });

  test("repairs a legacy saved contact and cleans legacy-only Other Contacts", async () => {
    const t = convexTest(schema, modules);
    const userId = "legacy-contact-user";
    const connectionId = await setupConnection(t, userId, "google");
    await t.run(async (ctx) => {
      await ctx.db.insert("contacts", {
        userId,
        resourceName: "people/legacy",
        emails: ["saved@example.com"],
        phones: [],
      });
      await ctx.db.insert("people", {
        userId,
        email: "orphan@example.com",
        sources: ["other"],
        updatedAt: 1,
      });
    });
    const attemptId = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId,
    });
    await t.mutation(internal.domains.sync.engine.upsertContactsPage, {
      connectionId,
      attemptId: attemptId!,
      feed: "contacts",
      contacts: [
        {
          id: "people/legacy",
          deleted: false,
          emails: ["saved@example.com"],
          phones: [],
        },
      ],
    });
    await t.mutation(internal.domains.sync.engine.beginContactsFullResync, {
      connectionId,
      attemptId: attemptId!,
      feed: "other",
    });
    await t.mutation(internal.domains.sync.engine.sweepLegacyOtherPeopleBatch, {
      connectionId,
      attemptId: attemptId!,
      cursor: null,
    });
    const rows = await t.run(async (ctx) => ({
      contacts: await ctx.db.query("contacts").collect(),
      people: await ctx.db.query("people").collect(),
    }));
    expect(rows.contacts).toHaveLength(1);
    expect(rows.contacts[0]).toMatchObject({
      connectionId,
      providerContactId: "people/legacy",
    });
    expect(rows.people.some((row) => row.email === "orphan@example.com")).toBe(
      false,
    );
  });
});

describe("shared generation and engagement maintenance", () => {
  test("connection reconciliation chooses the stable Google booking default once", async () => {
    const t = convexTest(schema, modules);
    const userId = "booking-target-user";
    const microsoftId = await setupConnection(t, userId, "microsoft");
    const googleId = await setupConnection(t, userId, "google");
    await t.run((ctx) =>
      ctx.db.insert("bookingPages", {
        userId,
        slug: "stable-target",
        displayName: "Stable Target",
        timeZone: "UTC",
        slotMinutes: 30,
        bufferMinutes: 0,
        minNoticeMinutes: 0,
        horizonDays: 30,
        rules: [],
        enabled: true,
      }),
    );
    const microsoftAttempt = await t.mutation(
      internal.domains.sync.engine.claimSyncLease,
      { connectionId: microsoftId },
    );
    const googleAttempt = await t.mutation(internal.domains.sync.engine.claimSyncLease, {
      connectionId: googleId,
    });
    const reconcile = (
      connectionId: Id<"calendarConnections">,
      attemptId: string,
      id: string,
    ) =>
      t.mutation(internal.domains.sync.engine.reconcileCalendars, {
        connectionId,
        attemptId,
        calendars: [
          { id, primary: true, writable: true, selected: true, shared: false },
        ],
      });
    await reconcile(microsoftId, microsoftAttempt!, "microsoft-primary");
    expect(
      await t.run((ctx) => ctx.db.query("bookingPages").unique()),
    ).not.toHaveProperty("targetConnectionId");
    const googleCalendars = await reconcile(
      googleId,
      googleAttempt!,
      "google-primary",
    );
    expect(await t.run((ctx) => ctx.db.query("bookingPages").unique())).toMatchObject({
      targetConnectionId: googleId,
      targetCalendarId: googleCalendars[0].localCalendarId,
    });

    await reconcile(microsoftId, microsoftAttempt!, "microsoft-primary");
    expect(await t.run((ctx) => ctx.db.query("bookingPages").unique())).toMatchObject({
      targetConnectionId: googleId,
      targetCalendarId: googleCalendars[0].localCalendarId,
    });
  });

  test("manual fan-out reports partial success and rejects aggregate total failure", () => {
    expect(
      summarizeConnectionSyncs([
        { status: "fulfilled", value: { changed: true, skipped: false } },
        { status: "rejected", reason: new Error("account two unavailable") },
      ]),
    ).toEqual({ total: 2, succeeded: 1, failed: 1, skipped: 0, changed: 1 });
    expect(() =>
      summarizeConnectionSyncs([
        { status: "rejected", reason: new Error("google failed") },
        { status: "rejected", reason: new Error("microsoft failed") },
      ]),
    ).toThrow(/all 2 calendar connections failed.*google failed.*microsoft failed/i);
  });

  test("chunks more than Convex's 8192 array limit into bounded mutations", () => {
    const chunks = chunkEngagementScores(
      Array.from({ length: 8_205 }, (_, index) => ({
        email: `person-${index}@example.com`,
        score: index,
        meetingCount: 1,
      })),
    );
    expect(chunks.flat()).toHaveLength(8_205);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBe(200);
  });

  test("coalesces dirty work and fences a superseded engagement generation", async () => {
    const t = convexTest(schema, modules);
    const userId = "coalesced-engagement";
    await t.run(async (ctx) => {
      await ctx.db.insert("userSyncState", {
        userId,
        engagementDirty: false,
        engagementGeneration: 0,
        updatedAt: 0,
      });
      for (const email of ["current@example.com", "stale@example.com"]) {
        await ctx.db.insert("people", {
          userId,
          email,
          sources: ["attendee"],
          score: 99,
          meetingCount: 9,
          updatedAt: 0,
        });
      }
    });
    await t.mutation(internal.domains.sync.engine.markEngagementDirty, { userId });
    await t.mutation(internal.domains.sync.engine.markEngagementDirty, { userId });
    const first = await t.mutation(internal.domains.sync.engine.claimEngagement, { userId });
    expect(first?.generation).toBe(1);
    await t.mutation(internal.domains.sync.engine.markEngagementDirty, { userId });
    expect(
      await t.mutation(internal.domains.sync.engine.applyEngagementScoreChunk, {
        userId,
        ...first!,
        scores: [{ email: "current@example.com", score: 5, meetingCount: 2 }],
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.domains.sync.engine.finishEngagement, {
        userId,
        ...first!,
      }),
    ).toBe(false);

    const second = await t.mutation(internal.domains.sync.engine.claimEngagement, { userId });
    expect(second?.generation).toBe(2);
    expect(
      await t.mutation(internal.domains.sync.engine.applyEngagementScoreChunk, {
        userId,
        ...second!,
        scores: [{ email: "current@example.com", score: 5, meetingCount: 2 }],
      }),
    ).toBe(true);
    const reset = await t.mutation(
      internal.domains.sync.engine.resetStaleEngagementScores,
      { userId, ...second!, cursor: null },
    );
    expect(reset?.done).toBe(true);
    expect(
      await t.mutation(internal.domains.sync.engine.finishEngagement, {
        userId,
        ...second!,
      }),
    ).toBe(true);
    const people = await t.run((ctx) => ctx.db.query("people").collect());
    expect(people.find((row) => row.email === "current@example.com")).toMatchObject({
      score: 5,
      meetingCount: 2,
      engagementGeneration: 2,
    });
    expect(people.find((row) => row.email === "stale@example.com")).toMatchObject({
      score: 0,
      meetingCount: 0,
      engagementGeneration: 2,
    });
  });

  test("shared reconciliation falls back to and repairs a legacy event", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("sharedEvents", {
        googleEventId: "legacy-shared",
        calendarId: "holidays",
        startMs: 1,
        endMs: 2,
        allDay: true,
        status: "confirmed",
        googleUpdatedMs: 1,
      }),
    );
    const claim = await t.mutation(internal.domains.sync.engine.claimSharedCalendarSync, {
      provider: "google",
      providerCalendarId: "holidays",
      refreshIntervalMs: 0,
    });
    await t.mutation(internal.domains.sync.engine.upsertSharedEventsPage, {
      provider: "google",
      providerCalendarId: "holidays",
      attemptId: claim.attemptId!,
      events: [event("legacy-shared", "holidays")],
    });
    const rows = await t.run((ctx) => ctx.db.query("sharedEvents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "google",
      providerCalendarId: "holidays",
      providerEventId: "legacy-shared",
    });
  });

  test("a failed shared refresh leaves the old generation visible and releases only its own lease", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("sharedEvents", {
        googleEventId: "old",
        calendarId: "holiday",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 1_000,
        provider: "google",
        providerCalendarId: "holiday",
        providerEventId: "old",
        providerUpdatedMs: 1_000,
        syncGeneration: 1,
      }),
    );
    const adapter = new FakeCalendarAdapter([
      {
        items: [event("new", "holiday")],
        nextPageCursor: "next" as PageCursor,
        commitCursor: null,
      },
      new Error("shared provider failure"),
    ]);
    await syncSharedCalendar(
      testActionCtx(t),
      adapter,
      "google",
      "holiday",
    );
    const rows = await t.run((ctx) => ctx.db.query("sharedEvents").collect());
    expect(rows.map((row) => row.providerEventId).sort()).toEqual(["new", "old"]);
    const state = await t.run((ctx) => ctx.db.query("sharedCalendars").unique());
    expect(state?.syncAttemptId).toBeUndefined();
    expect(state?.lastSyncAt).toBeUndefined();

    await syncSharedCalendar(
      testActionCtx(t),
      new FakeCalendarAdapter([
        {
          items: [event("fresh", "holiday")],
          nextPageCursor: null,
          commitCursor: "fresh-shared" as SyncCursor,
        },
      ]),
      "google",
      "holiday",
    );
    const refreshed = await t.run((ctx) => ctx.db.query("sharedEvents").collect());
    expect(refreshed.map((row) => row.providerEventId)).toEqual(["fresh"]);
    expect(
      (await t.run((ctx) => ctx.db.query("sharedCalendars").unique()))
        ?.syncGeneration,
    ).toBe(2);
  });

  test("engagement application resets people absent from the latest aggregate", async () => {
    const t = convexTest(schema, modules);
    const userId = "engagement-user";
    await t.run(async (ctx) => {
      await ctx.db.insert("people", {
        userId,
        email: "stale@example.com",
        sources: ["attendee"],
        score: 99,
        meetingCount: 10,
        lastMetMs: 100,
        updatedAt: 0,
      });
      await ctx.db.insert("people", {
        userId,
        email: "current@example.com",
        sources: ["attendee"],
        score: 1,
        meetingCount: 1,
        updatedAt: 0,
      });
    });
    await t.mutation(internal.calendarSync.applyEngagementScores, {
      userId,
      scores: [
        { email: "current@example.com", score: 5, meetingCount: 2 },
      ],
      cursor: null,
    });
    const people = await t.run((ctx) => ctx.db.query("people").collect());
    expect(people.find((row) => row.email === "stale@example.com")).toMatchObject({
      score: 0,
      meetingCount: 0,
    });
    expect(people.find((row) => row.email === "current@example.com")).toMatchObject({
      score: 5,
      meetingCount: 2,
    });
  });
});
