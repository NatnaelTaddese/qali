import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";

import { modules } from "../testModules";

const HOUR_MS = 60 * 60 * 1000;

/** A pending booking with only the fields expiration reads mattering. */
function bookingDoc(endMs: number) {
  return {
    hostUserId: "host",
    startMs: endMs - HOUR_MS / 2,
    endMs,
    timeZone: "UTC",
    requesterName: "Requester",
    requesterEmail: "req@example.com",
    status: "pending" as const,
    token: `tok_${endMs}`,
    createdAt: 1_000,
  };
}

/** Queue an entry on the legacy `internal.booking.expireBooking` path, the way
 * pre-cutover `requestBooking` deploys did. One hour out: convex-test backs the
 * queue with real timers, so the time must be far enough not to fire mid-test
 * yet inside the 32-bit delay that Node clamps to ~1ms. */
async function seedLegacyJob(t: ReturnType<typeof convexTest>) {
  const runAtMs = Date.now() + HOUR_MS;
  const bookingId: Id<"bookings"> = await t.run(async (ctx) => {
    const id = await ctx.db.insert("bookings", bookingDoc(runAtMs));
    await ctx.scheduler.runAt(runAtMs, internal.booking.expireBooking, {
      bookingId: id,
    });
    return id;
  });
  return { bookingId, runAtMs };
}

async function scheduledJobs(t: ReturnType<typeof convexTest>) {
  return await t.run(
    async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
  );
}

describe("migrateExpireBookingSchedules", () => {
  test("moves a pending legacy entry to the canonical path with time and args intact", async () => {
    const t = convexTest(schema, modules);
    const { bookingId, runAtMs } = await seedLegacyJob(t);

    const result = await t.mutation(
      internal.migrations.scheduledJobs.migrateExpireBookingSchedules,
      {},
    );
    expect(result).toMatchObject({ migrated: 1, done: true });
    expect(result.scanned).toBeGreaterThanOrEqual(1);

    const jobs = await scheduledJobs(t);
    const legacy = jobs.find((job) => job.name === "booking:expireBooking");
    expect(legacy?.state.kind).toBe("canceled");

    const migrated = jobs.find(
      (job) =>
        job.name.includes("domains/booking/mutations") &&
        job.name.endsWith(":expireBooking"),
    );
    expect(migrated?.state.kind).toBe("pending");
    expect(migrated?.scheduledTime).toBe(runAtMs);
    expect(migrated?.args).toEqual([{ bookingId }]);
  });

  test("dryRun counts the entry but leaves the queue untouched", async () => {
    const t = convexTest(schema, modules);
    await seedLegacyJob(t);

    const result = await t.mutation(
      internal.migrations.scheduledJobs.migrateExpireBookingSchedules,
      { dryRun: true },
    );
    expect(result).toMatchObject({ migrated: 1, done: true });

    const jobs = await scheduledJobs(t);
    const legacy = jobs.find((job) => job.name === "booking:expireBooking");
    expect(legacy?.state.kind).toBe("pending");
    expect(
      jobs.some((job) => job.name.includes("domains/booking/mutations")),
    ).toBe(false);
  });

  test("a second real run migrates nothing", async () => {
    const t = convexTest(schema, modules);
    await seedLegacyJob(t);

    await t.mutation(
      internal.migrations.scheduledJobs.migrateExpireBookingSchedules,
      {},
    );
    const rerun = await t.mutation(
      internal.migrations.scheduledJobs.migrateExpireBookingSchedules,
      {},
    );
    expect(rerun).toMatchObject({ migrated: 0, done: true });

    const jobs = await scheduledJobs(t);
    expect(
      jobs.filter((job) => job.name === "booking:expireBooking").map((job) => job.state.kind),
    ).toEqual(["canceled"]);
    expect(
      jobs
        .filter((job) => job.name.includes("domains/booking/mutations"))
        .map((job) => job.state.kind),
    ).toEqual(["pending"]);
  });
});
