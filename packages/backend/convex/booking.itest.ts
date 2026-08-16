/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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
  startMs: number,
  endMs: number,
  googleEventId: string,
) {
  return {
    userId,
    calendarId: CAL,
    googleEventId,
    startMs,
    endMs,
    allDay: false,
    status: "confirmed",
    googleUpdatedMs: 1_000,
  };
}

/** Seed a host page + a selected calendar so collectBusy can resolve visibility. */
async function seedHost(t: ReturnType<typeof convexTest>, userId = HOST) {
  await t.run(async (ctx) => {
    await ctx.db.insert("bookingPages", pageDoc(userId));
    await ctx.db.insert("calendars", {
      userId,
      googleCalendarId: CAL,
      selected: true,
    });
  });
}

const future = () => Date.now() + 60 * 60 * 1000;

describe("booking acceptance claim", () => {
  test("claims a free pending slot, then refuses a concurrent second claim", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();
    const bookingId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, start + 30 * 60_000)),
    );

    const first = await t.mutation(internal.booking.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-1",
      calendarId: CAL,
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
    const second = await t.mutation(internal.booking.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-2",
      calendarId: CAL,
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
      t.mutation(internal.booking.claimBookingAcceptance, {
        bookingId,
        hostUserId,
        attemptId: "a",
        calendarId: CAL,
      });

    expect(await claim(expiredId, HOST)).toBeNull(); // past its end
    expect(await claim(okId, "someone_else")).toBeNull(); // not the host
    expect(await claim(acceptedId, HOST)).toBeNull(); // already decided
  });

  test("refuses a slot that another calendar event now occupies", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();
    const end = start + 30 * 60_000;
    const bookingId = await t.run(async (ctx) => {
      // A meeting the host booked by hand now overlaps the requested slot.
      await ctx.db.insert("events", eventDoc(HOST, start, end, "conflict"));
      return ctx.db.insert("bookings", bookingDoc(HOST, start, end));
    });

    await expect(
      t.mutation(internal.booking.claimBookingAcceptance, {
        bookingId,
        hostUserId: HOST,
        attemptId: "a",
        calendarId: CAL,
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

    const first = await t.mutation(internal.booking.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-1",
      calendarId: CAL,
    });
    // A lost/uncertain response releases the claim without asserting success.
    await t.mutation(internal.booking.releaseBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-1",
      mayHaveSucceeded: false,
    });

    const second = await t.mutation(internal.booking.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "attempt-2",
      calendarId: CAL,
    });
    // Same operation id → the same client-assigned Google event id on retry, so a
    // create that actually landed reconciles instead of double-booking.
    expect(second!.operationId).toBe(first!.operationId);
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
    await t.mutation(internal.booking.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "holder",
      calendarId: CAL,
    });

    // A stale attempt cannot mark the booking accepted.
    const wrong = await t.mutation(internal.booking.markAccepted, {
      bookingId,
      hostUserId: HOST,
      googleEventId: "evt_google",
      calendarId: CAL,
      attemptId: "not-the-holder",
    });
    expect(wrong).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(bookingId)))!.status).toBe(
      "pending",
    );

    // The holder commits, and the accept-lease bookkeeping is cleared.
    const ok = await t.mutation(internal.booking.markAccepted, {
      bookingId,
      hostUserId: HOST,
      googleEventId: "evt_google",
      calendarId: CAL,
      attemptId: "holder",
    });
    expect(ok).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(bookingId));
    expect(row!.status).toBe("accepted");
    expect(row!.googleEventId).toBe("evt_google");
    // Dual-write: the neutral mirror is stamped alongside the Google id.
    expect(row!.connectionId).toBeDefined();
    expect(row!.providerEventId).toBe("evt_google");
    expect(row!.acceptAttemptId).toBeUndefined();
    expect(row!.acceptLeaseExpiresAt).toBeUndefined();
    expect(row!.acceptMayHaveSucceeded).toBeUndefined();
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
    await t.mutation(internal.booking.claimBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "holder",
      calendarId: CAL,
    });

    // A non-holder release is a no-op — it must not clear the live lease.
    await t.mutation(internal.booking.releaseBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "stale",
      mayHaveSucceeded: false,
    });
    expect(
      (await t.run((ctx) => ctx.db.get(bookingId)))!.acceptAttemptId,
    ).toBe("holder");

    // The holder releasing with an ambiguous outcome flags the booking so a
    // later reject cannot contradict a possibly-sent Google invitation.
    await t.mutation(internal.booking.releaseBookingAcceptance, {
      bookingId,
      hostUserId: HOST,
      attemptId: "holder",
      mayHaveSucceeded: true,
    });
    const row = await t.run((ctx) => ctx.db.get(bookingId));
    expect(row!.acceptAttemptId).toBeUndefined();
    expect(row!.acceptMayHaveSucceeded).toBe(true);
    const operation = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .filter((q) => q.eq(q.field("bookingId"), bookingId))
        .unique(),
    );
    expect(operation?.status).toBe("ambiguous");
    expect(operation?.mayHaveSucceeded).toBe(true);
  });
});

describe("booking context conflict detection", () => {
  test("reports a conflict when another event overlaps the pending slot", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();
    const end = start + 30 * 60_000;
    const freeId = await t.run((ctx) =>
      ctx.db.insert("bookings", bookingDoc(HOST, start, end)),
    );
    const free = await t.query(internal.booking.getBookingContext, {
      bookingId: freeId,
      hostUserId: HOST,
    });
    expect(free!.conflict).toBe(false);

    const busyId = await t.run(async (ctx) => {
      await ctx.db.insert("events", eventDoc(HOST, start, end, "overlap"));
      return ctx.db.insert(
        "bookings",
        bookingDoc(HOST, start, end, { token: "tok_busy" }),
      );
    });
    const busy = await t.query(internal.booking.getBookingContext, {
      bookingId: busyId,
      hostUserId: HOST,
    });
    expect(busy!.conflict).toBe(true);
  });

  test("detects a multi-day event that began well before the window", async () => {
    const t = convexTest(schema, modules);
    await seedHost(t);
    const start = future();
    const end = start + 30 * 60_000;
    // A vacation that started three days before the slot and runs past it. The
    // old startMs-based 24h lookback missed events beginning earlier than a day
    // ago; the endMs overlap scan catches it and withholds the slot.
    const bookingId = await t.run(async (ctx) => {
      await ctx.db.insert(
        "events",
        eventDoc(HOST, start - 3 * 24 * 60 * 60_000, end + 60_000, "vacation"),
      );
      return ctx.db.insert("bookings", bookingDoc(HOST, start, end));
    });

    const ctxRow = await t.query(internal.booking.getBookingContext, {
      bookingId,
      hostUserId: HOST,
    });
    expect(ctxRow!.conflict).toBe(true);
  });
});
