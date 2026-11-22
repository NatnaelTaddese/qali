import betterAuthTest from "@convex-dev/better-auth/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, components, internal } from "../../../convex/_generated/api";
import type { TableNames } from "../../../convex/_generated/dataModel";
import type { MutationCtx } from "../../../convex/_generated/server";
import schema from "../../../convex/schema";

import { modules } from "../../testModules";

/**
 * Every app table, classified. A table added to the schema without being
 * listed here fails the coverage test below, so whoever adds it has to decide
 * whether account deletion must erase it (and seed it in `seedUserRows`).
 */
const USER_KEYED = [
  "assistantActions",
  "assistantMessages",
  "assistantThreads",
  "assistantUserState",
  "availabilityOverrides",
  "bookingPages",
  "bookings",
  "calendarConnections",
  "calendarOperations",
  "calendars",
  "connectionSyncState",
  "contacts",
  "events",
  "notifications",
  "otherContactSources",
  "people",
  "personSourceClaims",
  "pushSubscriptions",
  "recurringSeries",
  "reminderDeliveries",
  "userPreferences",
  "userSyncState",
] as const satisfies readonly TableNames[];

/** Keyed by email rather than user id; cleared via purgeUserData's `email`. */
const EMAIL_KEYED = ["waitlist"] as const satisfies readonly TableNames[];

/** Rows that belong to no user: public calendars shared across everyone, and
 * anonymous booking-request rate-limit counters (keyed by the *requester's*
 * email or a page slug, pruned after a day by pruneRateLimits). */
const NOT_USER_KEYED = [
  "bookingRateLimits",
  "sharedCalendars",
  "sharedEvents",
] as const satisfies readonly TableNames[];

const ALL_TABLES = Object.keys(schema.tables).sort() as TableNames[];

/** One row in every user-keyed table for `userId`, wired together the way a
 * real account's rows are (calendars under a connection, events under a
 * calendar, messages under a thread …). */
async function seedUserRows(
  ctx: MutationCtx,
  userId: string,
  email: string,
): Promise<void> {
  const connectionId = await ctx.db.insert("calendarConnections", {
    userId,
    provider: "google",
    credentialRef: `google-${userId}`,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  });
  await ctx.db.insert("connectionSyncState", {
    connectionId,
    userId,
    status: "idle",
  });
  await ctx.db.insert("userSyncState", {
    userId,
    engagementDirty: false,
    updatedAt: 1,
  });
  const localCalendarId = await ctx.db.insert("calendars", {
    userId,
    connectionId,
    providerCalendarId: `primary-${userId}`,
    selected: true,
    isShared: false,
  });
  const eventId = await ctx.db.insert("events", {
    userId,
    connectionId,
    localCalendarId,
    providerEventId: `e-${userId}`,
    providerUpdatedMs: 1,
    startMs: Date.now(),
    endMs: Date.now() + 1,
    allDay: false,
    status: "confirmed",
  });
  await ctx.db.insert("recurringSeries", {
    userId,
    connectionId,
    localCalendarId,
    providerEventId: `s-${userId}`,
    providerUpdatedMs: 1,
    recurrence: ["RRULE:FREQ=DAILY"],
  });
  await ctx.db.insert("calendarOperations", {
    connectionId,
    userId,
    idempotencyKey: `op-${userId}`,
    kind: "create",
    status: "succeeded",
    createdAt: 1,
    updatedAt: 1,
  });
  await ctx.db.insert("contacts", {
    userId,
    connectionId,
    providerContactId: "people/1",
    emails: ["friend@example.com"],
    phones: [],
  });
  await ctx.db.insert("otherContactSources", {
    userId,
    connectionId,
    providerContactId: "otherContacts/1",
    emails: ["friend@example.com"],
  });
  await ctx.db.insert("personSourceClaims", {
    userId,
    connectionId,
    providerContactId: "people/1",
    email: "friend@example.com",
    source: "connection",
    updatedAt: 1,
  });
  await ctx.db.insert("people", {
    userId,
    email: "friend@example.com",
    sources: ["connection"],
    updatedAt: 1,
  });
  await ctx.db.insert("bookingPages", {
    userId,
    slug: `page-${userId}`,
    displayName: "Host",
    timeZone: "UTC",
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeMinutes: 0,
    horizonDays: 14,
    rules: [{ weekday: 1, startMin: 540, endMin: 1020 }],
    enabled: true,
    targetConnectionId: connectionId,
    targetCalendarId: localCalendarId,
  });
  await ctx.db.insert("availabilityOverrides", {
    userId,
    dateKey: "2026-11-23",
    intervals: [],
  });
  const bookingId = await ctx.db.insert("bookings", {
    hostUserId: userId,
    startMs: 1,
    endMs: 2,
    timeZone: "UTC",
    requesterName: "Guest",
    requesterEmail: "guest@example.com",
    status: "pending",
    token: `tok-${userId}`,
    createdAt: 1,
  });
  await ctx.db.insert("notifications", {
    userId,
    type: "booking_requested",
    title: "New request",
    bookingId,
    read: false,
    createdAt: 1,
  });
  await ctx.db.insert("reminderDeliveries", {
    userId,
    eventId,
    minutes: 10,
    fireAtMs: Date.now(),
    eventStartMs: Date.now(),
    status: "pending",
    createdAt: 1,
  });
  await ctx.db.insert("pushSubscriptions", {
    userId,
    endpoint: `https://push.example.com/${userId}`,
    keys: { p256dh: "p", auth: "a" },
    createdAt: 1,
  });
  await ctx.db.insert("userPreferences", {
    userId,
    timeZone: "Europe/London",
    defaultCalendarId: localCalendarId,
    updatedAt: 1,
  });
  const threadId = await ctx.db.insert("assistantThreads", {
    userId,
    title: "Plan my week",
    createdAt: 1,
    lastMessageAt: 1,
  });
  await ctx.db.insert("assistantMessages", {
    threadId,
    userId,
    role: "user",
    blocks: [],
    status: "complete",
    createdAt: 1,
  });
  await ctx.db.insert("assistantActions", {
    threadId,
    userId,
    toolCallId: "call-1",
    tool: "create_event",
    input: "{}",
    preview: "Lunch",
    status: "pending",
    createdAt: 1,
  });
  await ctx.db.insert("assistantUserState", {
    userId,
    windowStartMs: 1,
    requestCount: 1,
  });
  await ctx.db.insert("waitlist", { email, createdAt: 1 });
}

/** Every row in the app schema that still points at `userId` or `email`. */
async function rowsReferencing(
  ctx: MutationCtx,
  userId: string,
  email: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const table of ALL_TABLES) {
    for (const row of await ctx.db.query(table).collect()) {
      const doc = row as Record<string, unknown>;
      if (
        doc.userId === userId ||
        doc.hostUserId === userId ||
        doc.email === email
      ) {
        found.push(`${table}:${row._id}`);
      }
    }
  }
  return found;
}

/** Seed a Better Auth user with a Google account and a live session in the
 * component, the way a Google sign-in leaves them. */
async function seedAuthUser(
  t: ReturnType<typeof convexTest>,
  email: string,
): Promise<{ userId: string; sessionId: string }> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: email,
          email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    })) as { _id: string };
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "account",
        data: {
          userId: user._id,
          providerId: "google",
          accountId: `google-${user._id}`,
          accessToken: `access-${email}`,
          refreshToken: `refresh-${email}`,
          accessTokenExpiresAt: now + 60 * 60 * 1000,
          scope: "openid email",
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    const session = (await ctx.runMutation(
      components.betterAuth.adapter.create,
      {
        input: {
          model: "session",
          data: {
            userId: user._id,
            token: `session-${email}`,
            expiresAt: now + 24 * 60 * 60 * 1000,
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    )) as { _id: string };
    return { userId: user._id, sessionId: session._id };
  });
}

/** The victim's Better Auth rows still present, by model. */
async function authRowsFor(
  t: ReturnType<typeof convexTest>,
  userId: string,
): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    const count = async (model: "user" | "account" | "session") => {
      const result = (await ctx.runQuery(
        components.betterAuth.adapter.findMany,
        {
          model,
          where: [{ field: model === "user" ? "_id" : "userId", value: userId }],
          paginationOpts: { cursor: null, numItems: 100 },
        },
      )) as { page: unknown[] };
      return result.page.length;
    };
    return {
      user: await count("user"),
      account: await count("account"),
      session: await count("session"),
    };
  });
}

describe("account deletion coverage", () => {
  test("every schema table is classified for account deletion", () => {
    const classified = [...USER_KEYED, ...EMAIL_KEYED, ...NOT_USER_KEYED].sort();
    expect(classified).toEqual(ALL_TABLES);
  });

  test("purgeUserData leaves no row in any table referencing the user", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await seedUserRows(ctx, "victim", "victim@example.com");
      await seedUserRows(ctx, "bystander", "bystander@example.com");
    });
    // Seeding really did touch every user-keyed table, so the empty result
    // below means something.
    await t.run(async (ctx) => {
      for (const table of [...USER_KEYED, ...EMAIL_KEYED]) {
        expect(
          (await ctx.db.query(table).collect()).length,
          `${table} seeded`,
        ).toBeGreaterThan(0);
      }
    });

    const res = await t.mutation(internal.jobs.maintenance.purgeUserData, {
      userId: "victim",
      email: "victim@example.com",
    });
    expect(res.done).toBe(true);

    await t.run(async (ctx) => {
      expect(
        await rowsReferencing(ctx, "victim", "victim@example.com"),
      ).toEqual([]);
      // The bystander keeps one row in every table.
      for (const table of USER_KEYED) {
        expect(
          (await ctx.db.query(table).collect()).length,
          `${table} bystander row`,
        ).toBe(1);
      }
    });
  });

  test("purgeUserData drains tables larger than one batch", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await seedUserRows(ctx, "victim", "victim@example.com");
      const calendar = await ctx.db.query("calendars").first();
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert("events", {
          userId: "victim",
          connectionId: calendar!.connectionId,
          localCalendarId: calendar!._id,
          providerEventId: `bulk-${i}`,
          providerUpdatedMs: 1,
          startMs: i,
          endMs: i + 1,
          allDay: false,
          status: "confirmed",
        });
      }
    });
    const res = await t.mutation(internal.jobs.maintenance.purgeUserData, {
      userId: "victim",
      email: "victim@example.com",
    });
    expect(res.done).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run(async (ctx) => {
      expect(
        await rowsReferencing(ctx, "victim", "victim@example.com"),
      ).toEqual([]);
    });
  });
});

describe("deleteAccount", () => {
  let revoked: string[];

  beforeEach(() => {
    revoked = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://oauth2.googleapis.com/revoke") {
          const body = new URLSearchParams(String(init?.body ?? ""));
          revoked.push(body.get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected fetch in test: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function setup() {
    const t = convexTest(schema, modules);
    betterAuthTest.register(t);
    return t;
  }

  test("the signed-in user's action revokes the grant and erases app and auth rows", async () => {
    const t = setup();
    const victim = await seedAuthUser(t, "victim@example.com");
    const bystander = await seedAuthUser(t, "bystander@example.com");
    await t.run(async (ctx) => {
      await seedUserRows(ctx, victim.userId, "victim@example.com");
      await seedUserRows(ctx, bystander.userId, "bystander@example.com");
    });

    await t
      .withIdentity({ subject: victim.userId, sessionId: victim.sessionId })
      .action(api.domains.account.deletion.deleteAccount, {});

    expect(revoked).toEqual(["access-victim@example.com"]);
    await t.run(async (ctx) => {
      expect(
        await rowsReferencing(ctx, victim.userId, "victim@example.com"),
      ).toEqual([]);
    });
    expect(await authRowsFor(t, victim.userId)).toEqual({
      user: 0,
      account: 0,
      session: 0,
    });
    // The bystander is untouched on both sides.
    expect(await authRowsFor(t, bystander.userId)).toEqual({
      user: 1,
      account: 1,
      session: 1,
    });
    await t.run(async (ctx) => {
      expect(
        (await rowsReferencing(ctx, bystander.userId, "bystander@example.com"))
          .length,
      ).toBe(USER_KEYED.length + EMAIL_KEYED.length);
    });
  });

  test("refuses an unauthenticated caller", async () => {
    const t = setup();
    await expect(
      t.action(api.domains.account.deletion.deleteAccount, {}),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("the admin variant deletes by user id and is safe to re-run", async () => {
    const t = setup();
    const victim = await seedAuthUser(t, "victim@example.com");
    await t.run(async (ctx) => {
      await seedUserRows(ctx, victim.userId, "victim@example.com");
    });

    const first = await t.action(
      internal.domains.account.deletion.deleteUserAccount,
      { userId: victim.userId },
    );
    expect(first).toEqual({ revokedGrants: 1 });
    expect(await authRowsFor(t, victim.userId)).toEqual({
      user: 0,
      account: 0,
      session: 0,
    });

    // A re-run (say, after a partial failure) has no grant left to revoke and
    // still finishes cleanly, clearing a waitlist row by the supplied email.
    await t.run(async (ctx) => {
      await ctx.db.insert("waitlist", {
        email: "victim@example.com",
        createdAt: 2,
      });
    });
    const second = await t.action(
      internal.domains.account.deletion.deleteUserAccount,
      { userId: victim.userId, email: "victim@example.com" },
    );
    expect(second).toEqual({ revokedGrants: 0 });
    expect(revoked).toHaveLength(1);
    await t.run(async (ctx) => {
      expect(
        await rowsReferencing(ctx, victim.userId, "victim@example.com"),
      ).toEqual([]);
    });
  });
});
