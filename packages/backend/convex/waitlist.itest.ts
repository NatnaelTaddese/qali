/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

import { modules } from "../testModules";

describe("waitlist.join", () => {
  test("dedupes a repeat signup to a single row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.waitlist.join, { email: "a@example.com" });
    await t.mutation(api.waitlist.join, { email: "A@Example.com  " });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("waitlist").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("a@example.com");
  });

  test("rejects an invalid email", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.waitlist.join, { email: "not-an-email" }),
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
      t.mutation(api.waitlist.join, { email: "flood@example.com" }),
    ).rejects.toThrow();
    // Nothing was written past the cap.
    const rows = await t.run(async (ctx) =>
      ctx.db.query("waitlist").collect(),
    );
    expect(rows).toHaveLength(0);
  });
});
