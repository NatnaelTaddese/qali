// @ts-expect-error Bun supplies its test module at runtime; the Convex
// TypeScript project intentionally does not include Bun's ambient types.
import { describe, expect, test } from "bun:test";

import { selectVisibleNotifications } from "./notifications";

describe("selectVisibleNotifications", () => {
  test("keeps older unread rows reachable ahead of recent read history", () => {
    const unread = [{ _id: "old-unread" }];
    const recent = [
      { _id: "new-read-1" },
      { _id: "new-read-2" },
      { _id: "old-unread" },
    ];

    expect(selectVisibleNotifications(unread, recent, 2)).toEqual([
      { _id: "old-unread" },
      { _id: "new-read-1" },
    ]);
  });

  test("does not duplicate unread rows also present in recent history", () => {
    const row = { _id: "notification" };
    expect(selectVisibleNotifications([row], [row], 2)).toEqual([row]);
  });
});
