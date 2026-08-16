/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("stale assistant attempts cannot settle or reopen a newer claim", async () => {
  const t = convexTest(schema, modules);
  const userId = "assistant-fence-user";
  const threadId = await t.run((ctx) =>
    ctx.db.insert("assistantThreads", {
      userId,
      title: "Test",
      createdAt: 1,
      lastMessageAt: 1,
    }),
  );
  const actionId = await t.mutation(internal.assistantData.recordProposal, {
    threadId,
    userId,
    toolCallId: "tool-call",
    tool: "create_event",
    input: "{}",
    preview: "Create event",
  });
  const first = await t.mutation(internal.assistantData.claimAction, {
    actionId,
    userId,
  });
  const expiredAt = Date.now() - 1;
  await t.run((ctx) =>
    ctx.db.patch(actionId, { applyLeaseExpiresAt: expiredAt }),
  );
  await t.mutation(internal.assistantData.releaseStaleAction, {
    actionId,
    attemptId: first!.attemptId,
    applyLeaseExpiresAt: expiredAt,
  });
  const second = await t.mutation(internal.assistantData.claimAction, {
    actionId,
    userId,
  });
  expect(second?.attemptId).not.toBe(first?.attemptId);

  await t.mutation(internal.assistantData.settleClaimedAction, {
    actionId,
    attemptId: first!.attemptId,
    status: "failed",
    resultSummary: "stale failure",
  });
  await t.mutation(internal.assistantData.retryClaimedAction, {
    actionId,
    attemptId: first!.attemptId,
    resultSummary: "stale retry",
  });
  expect(await t.run((ctx) => ctx.db.get(actionId))).toMatchObject({
    status: "applying",
    attemptId: second!.attemptId,
  });

  await t.mutation(internal.assistantData.settleClaimedAction, {
    actionId,
    attemptId: second!.attemptId,
    status: "applied",
    resultSummary: "applied",
  });
  expect(await t.run((ctx) => ctx.db.get(actionId))).toMatchObject({
    status: "applied",
    resultSummary: "applied",
  });
});

test("an already-stored legacy applying action remains recoverable", async () => {
  const t = convexTest(schema, modules);
  const expiredAt = Date.now() - 1;
  const actionId = await t.run(async (ctx) => {
    const threadId = await ctx.db.insert("assistantThreads", {
      userId: "legacy-assistant",
      title: "Legacy",
      createdAt: 1,
      lastMessageAt: 1,
    });
    return await ctx.db.insert("assistantActions", {
      threadId,
      userId: "legacy-assistant",
      toolCallId: "legacy",
      tool: "create_event",
      input: "{}",
      preview: "Legacy action",
      status: "applying",
      applyLeaseExpiresAt: expiredAt,
      createdAt: 1,
    });
  });
  await t.mutation(internal.assistantData.releaseStaleAction, {
    actionId,
    applyLeaseExpiresAt: expiredAt,
  });
  expect((await t.run((ctx) => ctx.db.get(actionId)))?.status).toBe("pending");
});
