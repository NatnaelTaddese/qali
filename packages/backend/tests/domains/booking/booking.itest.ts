import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import { ProviderError } from "../../../convex/integrations/calendar/errors";
import type {
  CalendarProviderAdapter,
  CreateEventRequest,
  ProviderEvent,
} from "../../../convex/integrations/calendar/types";
import { reconcileBookingAcceptanceWithAdapter } from "../../../convex/domains/booking/service";
import schema from "../../../convex/schema";

import { modules } from "../../testModules";

const HOST = "host_user";
const CAL = "primary";

/** A host booking page with a permissive weekday schedule. Only the fields the
 * accept path reads (userId, timeZone, title, rules) actually matter here. */
function pageDoc(userId: string) {
  return {
    userId,
    slug: `slug_${userId}`,
    displayName: "Host",
    timeZone: "UTC",
    title: "Intro",
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeMinutes: 0,
    horizonDays: 60,
    rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      startMin: 0,
      endMin: 24 * 60,
    })),
    enabled: true,
  };
}

/** A pending booking request in the given window. */
function bookingDoc(
  hostUserId: string,
  startMs: number,
  endMs: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    hostUserId,
    startMs,
    endMs,
    timeZone: "UTC",
    requesterName: "Requester",
    requesterEmail: "req@example.com",
    status: "pending" as const,
    token: `tok_${startMs}`,
    createdAt: 1_000,
    ...overrides,
  };
}

/** A confirmed, opaque event on a selected calendar, used to make a slot busy. */
function eventDoc(
  userId: string,
  target: {
    connectionId: Id<"calendarConnections">;
    calendarId: Id<"calendars">;
  },
  startMs: number,
  endMs: number,
  providerEventId: string,
) {
  return {
    userId,
    connectionId: target.connectionId,
    localCalendarId: target.calendarId,
    providerEventId,
    providerUpdatedMs: 1_000,
    startMs,
    endMs,
    allDay: false,
    status: "confirmed",
  };
}

/** Seed a host page + a selected calendar so collectBusy can resolve visibility. */
async function seedHost(t: ReturnType<typeof convexTest>, userId = HOST) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const connectionId = await ctx.db.insert("calendarConnections", {
      userId,
      provider: "google",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const calendarId = await ctx.db.insert("calendars", {
      userId,
      providerCalendarId: CAL,
      connectionId,
      primary: true,
      accessRole: "owner",
      selected: true,
      isShared: false,
    });
    await ctx.db.insert("bookingPages", {
      ...pageDoc(userId),
      targetConnectionId: connectionId,
      targetCalendarId: calendarId,
    });
    return { connectionId, calendarId };
  });
}

const future = () => Date.now() + 60 * 60 * 1000;

function acceptedEvent(id = "accepted-event"): ProviderEvent {
  return {
    id,
    calendarId: CAL,
    startMs: future(),
    endMs: future() + 30 * 60_000,
    allDay: false,
    status: "confirmed",
    updatedMs: Date.now(),
  };
}

class BookingAdapter implements CalendarProviderAdapter {
  readonly provider = "google" as const;
  readonly capabilities = {
    contacts: false,
    recurringEvents: true,
    attendeeMembershipUpdates: true,
    rsvp: true,
    removeSelf: true,
    conference: { create: true, add: true, remove: true },
    idempotentCreate: true,
    idempotentUpdate: true,
    idempotentResponse: true,
    idempotentDelete: true,
  };
  readonly createKeys: (string | undefined)[] = [];
  reconcileCalls = 0;

  constructor(
    private readonly reconciliation: ProviderEvent | null | Error,
    private readonly created: ProviderEvent | Error = acceptedEvent(),
  ) {}

  async listCalendars() { return []; }
  async listEvents(): Promise<never> { throw new Error("not used"); }
  async getEvent(): Promise<never> { throw new Error("not used"); }
  async createEvent(request: CreateEventRequest): Promise<ProviderEvent> {
    this.createKeys.push(request.idempotencyKey);
    if (this.created instanceof Error) throw this.created;
    return this.created;
  }
  async reconcileAmbiguousCreate(): Promise<ProviderEvent | null> {
    this.reconcileCalls++;
    if (this.reconciliation instanceof Error) throw this.reconciliation;
    return this.reconciliation;
  }
  async updateEvent(): Promise<never> { throw new Error("not used"); }
  async respondToEvent(): Promise<never> { throw new Error("not used"); }
  async deleteEvent(): Promise<void> { throw new Error("not used"); }
}

function testActionCtx(t: ReturnType<typeof convexTest>): ActionCtx {
  return {
    runMutation: (reference: any, args?: any) => t.mutation(reference, args),
    runQuery: (reference: any, args?: any) => t.query(reference, args),
  } as ActionCtx;
}

async function ambiguousBooking(t: ReturnType<typeof convexTest>) {
  await seedHost(t);
  const start = future();
  const bookingId = await t.run((ctx) =>
    ctx.db.insert("bookings", bookingDoc(HOST, start, start + 30 * 60_000)),
  );
  const claim = await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
    bookingId,
    hostUserId: HOST,
    attemptId: "initial-provider-attempt",
  });
  await t.mutation(internal.domains.booking.mutations.releaseBookingAcceptance, {
    bookingId,
    hostUserId: HOST,
    attemptId: "initial-provider-attempt",
    mayHaveSucceeded: true,
  });
  return { bookingId, claim: claim! };
}

describe("booking acceptance claim", () => {
  test("claims a free pending slot, then refuses a concurrent second claim", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();
    const bookingId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, start + 30 * 60_000)),
    );

    const first = await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-1",
    });
    expect(first).not.toBeNull();
    expect(first!.operationId).toEqual(expect.any(String));
    const operation = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .filter((q) => q.eq(q.field("bookingId"), bookingId))
        .unique(),
    );
    expect(operation).toMatchObject({
      status: "pending",
      attemptId: "attempt-1",
      providerCalendarId: CAL,
    });

    // A different attempt cannot claim while the first lease is live.
    const second = await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-2",
    });
    expect(second).toBeNull();
  });

  test("refuses an expired, wrong-host, or non-pending booking", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();

    const expiredId = await t.run((ctx) =>
      ctx.db.insert(
        "bookings",
        bookingDoc(HOST, Date.now() - 60_000, Date.now() - 30_000),
      ),
    );
    const okId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, start + 30 * 60_000)),
    );
    const acceptedId = await t.run((ctx) =>
      ctx.db.insert(
        "bookings",
        bookingDoc(HOST, start, start + 30 * 60_000, { status: "accepted" }),
      ),
    );

    const claim = (bookingId: Id<"bookings">, hostUserId: string) =>
      t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
        bookingId,
        hostUserId,
        attemptId: "a",
      });

    expect(await claim(expiredId, HOST)).toBeNull(); // past its end
    expect(await claim(okId, "someone_else")).toBeNull(); // not the host
    expect(await claim(acceptedId, HOST)).toBeNull(); // already decided
  });

  test("refuses a slot that another calendar event now occupies", async () => {
    const t = convexTest(schema, modules);
    const target = await seedHost(t);
    const start = future();
    const end = start + 30 * 60_000;
    const bookingId = await t.run(async (ctx) => {
      // A meeting the host booked by hand now overlaps the requested slot.
      await ctx.db.insert("events", eventDoc(HOST, target, start, end, "conflict"));
      return ctx.db.insert("bookings", bookingDoc(HOST, start, end));
    });

    await expect(
      t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
        bookingId,
        hostUserId: HOST,
        attemptId: "a",
      }),
    ).rejects.toThrow(/no longer free/i);
  });

  test("a retry after release reuses the same stable operation id", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();
    const bookingId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, start + 30 * 60_000)),
    );

    const first = await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-1",
    });
    // A lost/uncertain response releases the claim without asserting success.
    await t.mutation(internal.domains.booking.mutations.releaseBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-1",
      mayHaveSucceeded: false,
    });

    const second = await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-2",
    });
    // Same operation id → the same client-assigned Google event id on retry, so a
    // create that actually landed reconciles instead of double-booking.
    expect(second!.operationId).toBe(first!.operationId);
    expect(second!.reconcileOnly).toBe(false);
  });

  test("an ambiguous retry reclaims the ledger only for reconciliation", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();
    const bookingId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, start + 30 * 60_000)),
    );
    const first = await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "first",
    });
    await t.mutation(internal.domains.booking.mutations.releaseBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "first",
      mayHaveSucceeded: true,
    });

    const retry = await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "retry",
    });
    expect(retry).toMatchObject({
      operationId: first!.operationId,
      reconcileOnly: true,
    });
  });

  test("an operation with a nulled local calendar re-resolves it by provider id", async () => {
    const t = convexTest(schema, modules);
    const { connectionId, calendarId } = await seedHost(t);
    const start = future();
    const bookingId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, start + 30 * 60_000)),
    );
    await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-1",
    });
    await t.mutation(internal.domains.booking.mutations.releaseBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-1",
      mayHaveSucceeded: false,
    });
    // The provider cutover nulls the operation's local calendar reference and
    // the booking's target pair; the provider calendar id survives.
    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("calendarOperations")
        .withIndex("by_bookingId", (q) => q.eq("bookingId", bookingId))
        .unique();
      await ctx.db.patch(operation!._id, { localCalendarId: undefined });
      await ctx.db.patch(bookingId, {
        targetConnectionId: undefined,
        targetCalendarId: undefined,
      });
    });

    const retry = await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-2",
    });
    expect(retry).toMatchObject({
      connectionId,
      localCalendarId: calendarId,
      providerCalendarId: CAL,
    });
    const operation = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .withIndex("by_bookingId", (q) => q.eq("bookingId", bookingId))
        .unique(),
    );
    expect(operation?.localCalendarId).toBe(calendarId);
  });
});

describe("scheduled booking acceptance reconciliation", () => {
  test("recovers a lost acceptance action with the same operation key", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();
    const bookingId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, start + 30 * 60_000)),
    );
    const claim = await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "lost-action",
    });
    const operation = await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("calendarOperations")
        .withIndex("by_bookingId", (q) => q.eq("bookingId", bookingId))
        .unique();
      await ctx.db.patch(operation!._id, { leaseExpiresAt: Date.now() - 1 });
      return operation;
    });
    const retry = await t.mutation(
      internal.domains.booking.mutations.claimScheduledBookingAcceptance,
      {
        bookingId,
        attemptId: "scheduled-recovery",
        expectedGeneration: operation!.reconcileGeneration!,
      },
    );
    expect(retry).toMatchObject({
      operationId: claim!.operationId,
      reconcileOnly: true,
      reconcileAttemptCount: 1,
    });
  });

  test("accepts when reconciliation finds the provider event", async () => {
    const t = convexTest(schema, modules);
    const { bookingId, claim } = await ambiguousBooking(t);
    const adapter = new BookingAdapter(acceptedEvent("provider-landed"));
    await reconcileBookingAcceptanceWithAdapter(
      testActionCtx(t),
      { bookingId, expectedGeneration: claim.reconcileGeneration },
      adapter,
    );
    expect((await t.run((ctx) => ctx.db.get(bookingId)))?.status).toBe("accepted");
    expect(adapter.reconcileCalls).toBe(1);
    expect(adapter.createKeys).toEqual([]);
  });

  test("retries a confirmed not-landed create once with the same key", async () => {
    const t = convexTest(schema, modules);
    const { bookingId, claim } = await ambiguousBooking(t);
    const adapter = new BookingAdapter(null, acceptedEvent("provider-retried"));
    await reconcileBookingAcceptanceWithAdapter(
      testActionCtx(t),
      { bookingId, expectedGeneration: claim.reconcileGeneration },
      adapter,
    );
    const booking = await t.run((ctx) => ctx.db.get(bookingId));
    expect(booking?.status).toBe("accepted");
    expect(adapter.createKeys).toEqual([claim.operationId]);
  });

  test("expires a past booking after reconciliation proves it did not land", async () => {
    const t = convexTest(schema, modules);
    const { bookingId, claim } = await ambiguousBooking(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(bookingId, {
        startMs: Date.now() - 60_000,
        endMs: Date.now() - 1,
      });
      const operation = await ctx.db
        .query("calendarOperations")
        .withIndex("by_bookingId", (q) => q.eq("bookingId", bookingId))
        .unique();
      await ctx.db.patch(operation!._id, { requestFingerprint: undefined });
    });
    const adapter = new BookingAdapter(null);
    await reconcileBookingAcceptanceWithAdapter(
      testActionCtx(t),
      { bookingId, expectedGeneration: claim.reconcileGeneration },
      adapter,
    );
    await t.mutation(internal.domains.booking.mutations.expireBooking, { bookingId });
    expect((await t.run((ctx) => ctx.db.get(bookingId)))?.status).toBe("expired");
    expect(adapter.createKeys).toEqual([]);
  });

  test("bounds repeated ambiguity and leaves a safe retryable ledger state", async () => {
    const t = convexTest(schema, modules);
    const { bookingId } = await ambiguousBooking(t);
    const adapter = new BookingAdapter(
      new ProviderError("ambiguous", "provider response lost"),
    );
    for (let attempt = 0; attempt < 7; attempt++) {
      const operation = await t.run((ctx) =>
        ctx.db
          .query("calendarOperations")
          .withIndex("by_bookingId", (q) => q.eq("bookingId", bookingId))
          .unique(),
      );
      await reconcileBookingAcceptanceWithAdapter(
        testActionCtx(t),
        {
          bookingId,
          expectedGeneration: operation!.reconcileGeneration!,
        },
        adapter,
      );
    }
    const operation = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .withIndex("by_bookingId", (q) => q.eq("bookingId", bookingId))
        .unique(),
    );
    expect(operation).toMatchObject({
      status: "ambiguous",
      reconcileAttemptCount: 5,
      mayHaveSucceeded: true,
    });
    expect(adapter.reconcileCalls).toBe(5);
    expect(adapter.createKeys).toEqual([]);
  });

  test("is a no-op after account connection deletion", async () => {
    const t = convexTest(schema, modules);
    const { bookingId, claim } = await ambiguousBooking(t);
    await t.run(async (ctx) => {
      const operation = await ctx.db
        .query("calendarOperations")
        .withIndex("by_bookingId", (q) => q.eq("bookingId", bookingId))
        .unique();
      if (operation) await ctx.db.delete(operation.connectionId);
    });
    const adapter = new BookingAdapter(acceptedEvent());
    await reconcileBookingAcceptanceWithAdapter(
      testActionCtx(t),
      { bookingId, expectedGeneration: claim.reconcileGeneration },
      adapter,
    );
    expect(adapter.reconcileCalls).toBe(0);
    expect(adapter.createKeys).toEqual([]);
  });
});

describe("booking acceptance settle", () => {
  test("markAccepted commits only for the holding attempt", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();
    const bookingId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, start + 30 * 60_000)),
    );
    await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "holder",
    });

    // A stale attempt cannot mark the booking accepted.
    const wrong = await t.mutation(internal.domains.booking.mutations.markAccepted, {
      bookingId,
      hostUserId: HOST,
      providerEventId: "evt_google",
      providerCalendarId: CAL,
      attemptId: "not-the-holder",
    });
    expect(wrong).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(bookingId)))!.status).toBe(
      "pending",
    );

    // The holder commits, and the ledger lease is cleared.
    const ok = await t.mutation(internal.domains.booking.mutations.markAccepted, {
      bookingId,
      hostUserId: HOST,
      providerEventId: "evt_google",
      providerCalendarId: CAL,
      attemptId: "holder",
    });
    expect(ok).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(bookingId));
    expect(row!.status).toBe("accepted");
    expect(row!.providerEventId).toBe("evt_google");
    expect(row!.connectionId).toBeDefined();
    expect(row!.targetConnectionId).toBe(row!.connectionId);
    expect(row!.targetCalendarId).toBeDefined();
    const operation = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .filter((q) => q.eq(q.field("bookingId"), bookingId))
        .unique(),
    );
    expect(operation).toMatchObject({
      status: "succeeded",
      providerEventId: "evt_google",
    });
    expect(operation?.attemptId).toBeUndefined();
    expect(operation?.leaseExpiresAt).toBeUndefined();
  });

  test("release records may-have-succeeded only from the holder", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();
    const bookingId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, start + 30 * 60_000)),
    );
    await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "holder",
    });

    // A non-holder release is a no-op — it must not clear the live lease.
    await t.mutation(internal.domains.booking.mutations.releaseBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "stale",
      mayHaveSucceeded: false,
    });
    const held = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .filter((q) => q.eq(q.field("bookingId"), bookingId))
        .unique(),
    );
    expect(held?.status).toBe("pending");
    expect(held?.attemptId).toBe("holder");

    // The holder releasing with an ambiguous outcome flags the ledger so a
    // later reject cannot contradict a possibly-sent provider invitation.
    await t.mutation(internal.domains.booking.mutations.releaseBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "holder",
      mayHaveSucceeded: true,
    });
    const operation = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .filter((q) => q.eq(q.field("bookingId"), bookingId))
        .unique(),
    );
    expect(operation?.status).toBe("ambiguous");
    expect(operation?.mayHaveSucceeded).toBe(true);
    expect(operation?.attemptId).toBeUndefined();
  });
});

describe("booking acceptance authority", () => {
  test("ambiguous acceptance stays pending and reconcilable after lease loss", async () => {
    const t = convexTest(schema, modules);
    const { connectionId, calendarId } = await seedHost(t);
    const endMs = Date.now() - 1_000;
    const bookingId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, endMs - 30 * 60_000, endMs)),
    );
    const operationId = await t.run((ctx) => {
      const now = Date.now();
      return ctx.db.insert("calendarOperations", {
        connectionId,
        userId: HOST,
        idempotencyKey: "expiry-op",
        kind: "create",
        status: "pending",
        bookingId,
        attemptId: "holder",
        leaseExpiresAt: now + 60_000,
        mayHaveSucceeded: true,
        localCalendarId: calendarId,
        providerCalendarId: CAL,
        createdAt: now,
        updatedAt: now,
      });
    });

    await t.mutation(internal.domains.booking.mutations.expireBooking, { bookingId });
    expect((await t.run((ctx) => ctx.db.get(bookingId)))?.status).toBe(
      "pending",
    );

    await t.run((ctx) =>
      ctx.db.patch(operationId, { leaseExpiresAt: Date.now() - 1 }),
    );
    await t.mutation(internal.domains.booking.mutations.expireBooking, { bookingId });
    expect((await t.run((ctx) => ctx.db.get(bookingId)))?.status).toBe(
      "pending",
    );
    const retry = await t.mutation(
      internal.domains.booking.mutations.claimBookingAcceptance,
      { bookingId, hostUserId: HOST, attemptId: "reconcile" },
    );
    expect(retry).toMatchObject({
      operationId: "expiry-op",
      reconcileOnly: true,
    });
  });

  test("a definitively failed past acceptance can expire", async () => {
    const t = convexTest(schema, modules);
    const { connectionId, calendarId } = await seedHost(t);
    const endMs = Date.now() - 1_000;
    const bookingId = await t.run(async (ctx) => {
      const bookingId = await ctx.db.insert(
        "bookings",
        bookingDoc(HOST, endMs - 30 * 60_000, endMs),
      );
      await ctx.db.insert("calendarOperations", {
        connectionId,
        userId: HOST,
        idempotencyKey: "failed-op",
        kind: "create",
        status: "failed",
        bookingId,
        localCalendarId: calendarId,
        providerCalendarId: CAL,
        createdAt: 1,
        updatedAt: 1,
      });
      return bookingId;
    });
    await t.mutation(internal.domains.booking.mutations.expireBooking, { bookingId });
    expect((await t.run((ctx) => ctx.db.get(bookingId)))?.status).toBe(
      "expired",
    );
  });

  test("the ledger blocks rejection during a lease and after ambiguity", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();
    const bookingId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, start + 30 * 60_000)),
    );
    await t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "holder",
    });
    await expect(
      t.mutation(internal.domains.booking.mutations.rejectBookingForHost, {
        bookingId,
        hostUserId: HOST,
      }),
    ).rejects.toThrow(/currently being accepted/i);

    await t.mutation(internal.domains.booking.mutations.releaseBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "holder",
      mayHaveSucceeded: true,
    });
    await expect(
      t.mutation(internal.domains.booking.mutations.rejectBookingForHost, {
        bookingId,
        hostUserId: HOST,
      }),
    ).rejects.toThrow(/may have reached the calendar provider/i);
  });

  test("rejects foreign, paused, and read-only targets", async () => {
    const t = convexTest(schema, modules);
    const target = await seedHost(t);
    const start = future();
    const insertBooking = (
      token: string,
      overrides: Record<string, unknown> = {},
    ) =>
      t.run((ctx) =>
        ctx.db.insert(
          "bookings",
          bookingDoc(HOST, start, start + 30 * 60_000, { token, ...overrides }),
        ),
      );

    const foreign = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: "other",
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      const calendarId = await ctx.db.insert("calendars", {
        userId: "other",
        connectionId,
        providerCalendarId: "other-primary",
        primary: true,
        accessRole: "owner",
        selected: true,
        isShared: false,
      });
      return { connectionId, calendarId };
    });
    const foreignBooking = await insertBooking("foreign", {
      targetConnectionId: foreign.connectionId,
      targetCalendarId: foreign.calendarId,
    });
    await expect(
      t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
        bookingId: foreignBooking,
        hostUserId: HOST,
        attemptId: "foreign",
      }),
    ).rejects.toThrow(/target is unavailable/i);

    await t.run((ctx) =>
      ctx.db.patch(target.connectionId, { status: "paused" }),
    );
    const pausedBooking = await insertBooking("paused", {
      targetConnectionId: target.connectionId,
      targetCalendarId: target.calendarId,
    });
    await expect(
      t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
        bookingId: pausedBooking,
        hostUserId: HOST,
        attemptId: "paused",
      }),
    ).rejects.toThrow(/target is unavailable/i);

    await t.run(async (ctx) => {
      await ctx.db.patch(target.connectionId, { status: "active" });
      await ctx.db.patch(target.calendarId, {
        primary: false,
        accessRole: "reader",
      });
    });
    const readOnlyBooking = await insertBooking("read-only", {
      targetConnectionId: target.connectionId,
      targetCalendarId: target.calendarId,
    });
    await expect(
      t.mutation(internal.domains.booking.mutations.claimBookingAcceptance, {
        bookingId: readOnlyBooking,
        hostUserId: HOST,
        attemptId: "read-only",
      }),
    ).rejects.toThrow(/target is unavailable/i);
  });

  test("a page without targets resolves and persists the primary target", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("bookingPages", {
        ...pageDoc(HOST),
        slug: "self-heal-host",
      });
      // Both page targets absent — the cutover nulls the pair — so the request
      // must fall back to the host's primary calendar and persist it.
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: HOST,
        provider: "google",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("calendars", {
        userId: HOST,
        connectionId,
        providerCalendarId: CAL,
        primary: true,
        accessRole: "owner",
        selected: true,
        isShared: false,
      });
    });
    const startMs =
      Math.ceil((Date.now() + 60 * 60_000) / (30 * 60_000)) * (30 * 60_000);
    await t.mutation(api.domains.booking.mutations.requestBooking, {
      slug: "self-heal-host",
      startMs,
      name: "Requester",
      email: "requester@example.com",
      timeZone: "UTC",
    });

    await t.run(async (ctx) => {
      const page = await ctx.db
        .query("bookingPages")
        .withIndex("by_user", (q) => q.eq("userId", HOST))
        .unique();
      const booking = await ctx.db
        .query("bookings")
        .withIndex("by_host_and_start", (q) => q.eq("hostUserId", HOST))
        .unique();
      expect(page?.targetConnectionId).toBeDefined();
      expect(page?.targetCalendarId).toBeDefined();
      expect(booking).toMatchObject({
        connectionId: page?.targetConnectionId,
        targetConnectionId: page?.targetConnectionId,
        targetCalendarId: page?.targetCalendarId,
      });
    });
  });

  test("accepted provider events mirror through calendar storage", async () => {
    const t = convexTest(schema, modules);
    const { connectionId, calendarId } = await seedHost(t);
    await t.mutation(internal.domains.calendar.mutations.mirrorProviderEvent, {
      userId: HOST,
      connectionId,
      localCalendarId: calendarId,
      event: {
        id: "provider-event",
        calendarId: CAL,
        summary: "Intro with Requester",
        startMs: 10_000,
        endMs: 20_000,
        allDay: false,
        status: "confirmed",
        updatedMs: 9_000,
        attendees: [{ email: "requester@example.com" }],
      },
    });
    const event = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_connection_and_localCalendarId_and_providerEventId", (q) =>
          q
            .eq("connectionId", connectionId)
            .eq("localCalendarId", calendarId)
            .eq("providerEventId", "provider-event"),
        )
        .unique(),
    );
    expect(event).toMatchObject({
      userId: HOST,
      connectionId,
      localCalendarId: calendarId,
      providerEventId: "provider-event",
      providerUpdatedMs: 9_000,
    });
  });
});

describe("booking context conflict detection", () => {
  test("slot generation uses caller-materialized time", async () => {
    const t = convexTest(schema, modules);
    const fromMs = Date.UTC(2030, 0, 1);
    await t.run((ctx) =>
      ctx.db.insert("bookingPages", {
        ...pageDoc(HOST),
        slug: "materialized-time",
        minNoticeMinutes: 120,
      }),
    );
    const earlier = await t.query(api.domains.booking.queries.listSlots, {
      slug: "materialized-time",
      fromMs,
      toMs: fromMs + 4 * 60 * 60_000,
      nowMs: fromMs - 3 * 60 * 60_000,
    });
    const current = await t.query(api.domains.booking.queries.listSlots, {
      slug: "materialized-time",
      fromMs,
      toMs: fromMs + 4 * 60 * 60_000,
      nowMs: fromMs,
    });
    expect(earlier.slots[0]?.startMs).toBe(fromMs);
    expect(current.slots[0]?.startMs).toBe(fromMs + 2 * 60 * 60_000);
  });

  test("reports a conflict when another event overlaps the pending slot", async () => {
    const t = convexTest(schema, modules);
    const target = await seedHost(t);
    const start = future();
    const end = start + 30 * 60_000;
    const freeId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, end)),
    );
    const free = await t.query(internal.domains.booking.queries.getBookingContext, {
      bookingId: freeId,
      hostUserId: HOST,
    });
    expect(free!.conflict).toBe(false);

    const busyId = await t.run(async (ctx) => {
      await ctx.db.insert("events", eventDoc(HOST, target, start, end, "overlap"));
      return ctx.db.insert(
        "bookings",
        bookingDoc(HOST, start, end, { token: "tok_busy" }),
      );
    });
    const busy = await t.query(internal.domains.booking.queries.getBookingContext, {
      bookingId: busyId,
      hostUserId: HOST,
    });
    expect(busy!.conflict).toBe(true);
  });

  test("detects a multi-day event that began well before the window", async () => {
    const t = convexTest(schema, modules);
    const target = await seedHost(t);
    const start = future();
    const end = start + 30 * 60_000;
    // A vacation that started three days before the slot and runs past it. The
    // old startMs-based 24h lookback missed events beginning earlier than a day
    // ago; the endMs overlap scan catches it and withholds the slot.
    const bookingId = await t.run(async (ctx) => {
      await ctx.db.insert(
        "events",
        eventDoc(HOST, target, start - 3 * 24 * 60 * 60_000, end + 60_000, "vacation"),
      );
      return ctx.db.insert("bookings", bookingDoc(HOST, start, end));
    });

    const ctxRow = await t.query(internal.domains.booking.queries.getBookingContext, {
      bookingId,
      hostUserId: HOST,
    });
    expect(ctxRow!.conflict).toBe(true);
  });
});
