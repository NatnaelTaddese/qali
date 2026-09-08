import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import {
  recordPushResultsCore,
  subscribeCore,
  unsubscribeCore,
} from "../../../convex/domains/push/mutations";
import schema from "../../../convex/schema";

import { modules } from "../../testModules";

const KEYS = { p256dh: "p256", auth: "auth" };

async function rows(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) => ctx.db.query("pushSubscriptions").collect());
}

describe("push subscriptions", () => {
  test("upserts by endpoint and rebinds a re-registered endpoint to the new user", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      subscribeCore(ctx, "alice", {
        endpoint: "https://push.example/one",
        keys: KEYS,
        userAgent: "Chrome",
      }),
    );
    await t.run((ctx) =>
      subscribeCore(ctx, "alice", {
        endpoint: "https://push.example/one",
        keys: { p256dh: "rotated", auth: "auth" },
      }),
    );
    expect(await rows(t)).toHaveLength(1);
    expect((await rows(t))[0]?.keys.p256dh).toBe("rotated");

    // Same browser, someone else signs in.
    await t.run((ctx) =>
      subscribeCore(ctx, "bob", { endpoint: "https://push.example/one", keys: KEYS }),
    );
    expect((await rows(t)).map((r) => r.userId)).toEqual(["bob"]);
  });

  test("rejects non-https endpoints", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run((ctx) =>
        subscribeCore(ctx, "alice", { endpoint: "http://push.example/x", keys: KEYS }),
      ),
    ).rejects.toThrow("https");
    await expect(
      t.run((ctx) => subscribeCore(ctx, "alice", { endpoint: "nope", keys: KEYS })),
    ).rejects.toThrow("Invalid");
  });

  test("caps subscriptions per user by dropping the oldest", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 11; i++) {
      await t.run(async (ctx) => {
        await subscribeCore(ctx, "alice", {
          endpoint: `https://push.example/${i}`,
          keys: KEYS,
        });
        // Distinct createdAt so "oldest" is well defined.
        const row = (await ctx.db
          .query("pushSubscriptions")
          .withIndex("by_endpoint", (q) => q.eq("endpoint", `https://push.example/${i}`))
          .unique())!;
        await ctx.db.patch(row._id, { createdAt: i });
      });
    }
    const endpoints = (await rows(t)).map((r) => r.endpoint).sort();
    expect(endpoints).toHaveLength(10);
    expect(endpoints).not.toContain("https://push.example/0");
  });

  test("unsubscribe only removes the caller's own row", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      subscribeCore(ctx, "alice", { endpoint: "https://push.example/a", keys: KEYS }),
    );
    await t.run((ctx) => unsubscribeCore(ctx, "bob", { endpoint: "https://push.example/a" }));
    expect(await rows(t)).toHaveLength(1);
    await t.run((ctx) => unsubscribeCore(ctx, "alice", { endpoint: "https://push.example/a" }));
    expect(await rows(t)).toHaveLength(0);
  });

  test("recordPushResults deletes gone endpoints and stamps the rest", async () => {
    const t = convexTest(schema, modules);
    for (const name of ["gone", "ok", "flaky"]) {
      await t.run((ctx) =>
        subscribeCore(ctx, "alice", { endpoint: `https://push.example/${name}`, keys: KEYS }),
      );
    }
    await t.run((ctx) =>
      recordPushResultsCore(ctx, {
        userId: "alice",
        delivered: ["https://push.example/ok"],
        gone: ["https://push.example/gone", "https://push.example/not-mine"],
        failed: ["https://push.example/flaky"],
      }),
    );
    const byName = Object.fromEntries(
      (await rows(t)).map((r) => [r.endpoint.split("/").pop(), r]),
    );
    expect(Object.keys(byName).sort()).toEqual(["flaky", "ok"]);
    expect(byName.ok?.failedAt).toBeUndefined();
    expect(typeof byName.flaky?.failedAt).toBe("number");
  });
});
