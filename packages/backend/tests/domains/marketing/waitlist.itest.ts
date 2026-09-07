import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "../../../convex/_generated/api";
import schema from "../../../convex/schema";

import { modules } from "../../testModules";

describe("waitlist.join", () => {
  test("dedupes a repeat signup to a single row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.domains.marketing.mutations.join, { email: "a@example.com" });
    await t.mutation(api.domains.marketing.mutations.join, { email: "A@Example.com  " });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("waitlist").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("a@example.com");
  });

  test("rejects an invalid email", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.domains.marketing.mutations.join, { email: "not-an-email" }),
    ).rejects.toThrow();
  });

  test("rejects once the global hourly cap is reached", async () => {
    const t = convexTest(schema, modules);
    // Seed the global counter at its ceiling (MAX_JOINS_GLOBAL) so the next join
    // trips the cap without looping hundreds of times.
    await t.run(async (ctx) => {
      await ctx.db.insert("bookingRateLimits", {
        key: "waitlist:global",
        windowStartMs: Date.now(),
        count: 600,
      });
    });
    await expect(
      t.mutation(api.domains.marketing.mutations.join, { email: "flood@example.com" }),
    ).rejects.toThrow();
    // Nothing was written past the cap.
    const rows = await t.run(async (ctx) =>
      ctx.db.query("waitlist").collect(),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("waitlist.join input bounds", () => {
  test("rejects an oversized source label", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.domains.marketing.mutations.join, {
        email: "big@example.com",
        source: "x".repeat(10_000),
      }),
    ).rejects.toThrow();
    const rows = await t.run((ctx) => ctx.db.query("waitlist").collect());
    expect(rows).toEqual([]);
  });
});
