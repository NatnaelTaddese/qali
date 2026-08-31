// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import type { Doc } from "../../../convex/_generated/dataModel";
import { preferredConnection } from "../../../convex/domains/calendar/connections";

function conn(
  id: string,
  over: Partial<Doc<"calendarConnections">> = {},
): Doc<"calendarConnections"> {
  return {
    _id: id,
    _creationTime: 0,
    userId: "user",
    provider: "google",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Doc<"calendarConnections">;
}

describe("preferredConnection", () => {
  test("is empty-safe and skips inactive connections", () => {
    expect(preferredConnection([])).toBeUndefined();
    expect(
      preferredConnection([conn("paused", { status: "paused" })]),
    ).toBeUndefined();
    expect(
      preferredConnection([
        conn("paused", { status: "paused", createdAt: 1 }),
        conn("active", { createdAt: 2 }),
      ])?._id,
    ).toBe("active");
  });

  test("prefers Google, then the oldest connection", () => {
    expect(
      preferredConnection([
        conn("ms", { provider: "microsoft", createdAt: 1 }),
        conn("google", { createdAt: 2 }),
      ])?._id,
    ).toBe("google");
    // The login grant predates a linked account, so it stays preferred.
    expect(
      preferredConnection([
        conn("linked", { createdAt: 2 }),
        conn("login", { createdAt: 1 }),
      ])?._id,
    ).toBe("login");
    expect(
      preferredConnection([
        conn("b", { createdAt: 1, _creationTime: 2 } as never),
        conn("a", { createdAt: 1, _creationTime: 1 } as never),
      ])?._id,
    ).toBe("a");
  });

  test("does not mutate its input order", () => {
    const rows = [conn("second", { createdAt: 2 }), conn("first", { createdAt: 1 })];
    preferredConnection(rows);
    expect(rows.map((row) => row._id)).toEqual(["second", "first"]);
  });
});
