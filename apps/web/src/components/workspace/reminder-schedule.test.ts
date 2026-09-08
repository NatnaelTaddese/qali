// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
  BUCKET_MS,
  GRACE_MS,
  bucketNow,
  diffReminders,
  dueState,
  type UpcomingReminder,
} from "./reminder-schedule";

const r = (eventId: string, minutes: number, fireAtMs: number): UpcomingReminder => ({
  eventId,
  minutes,
  fireAtMs,
  startMs: fireAtMs + minutes * 60_000,
  allDay: false,
});

describe("reminder-schedule", () => {
  test("bucketNow floors to the bucket", () => {
    expect(bucketNow(BUCKET_MS * 3 + 1)).toBe(BUCKET_MS * 3);
    expect(bucketNow(BUCKET_MS * 3)).toBe(BUCKET_MS * 3);
  });

  test("dueState boundaries", () => {
    const now = 1_000_000_000;
    expect(dueState(now + 1, now)).toBe("future");
    expect(dueState(now, now)).toBe("due");
    expect(dueState(now - GRACE_MS, now)).toBe("due");
    expect(dueState(now - GRACE_MS - 1, now)).toBe("stale");
  });

  test("diffReminders adds new keys, removes gone ones, and re-adds moved ones", () => {
    const scheduled = new Map([
      ["a:10", 100],
      ["b:10", 200],
      ["c:10", 300],
    ]);
    const { added, removed } = diffReminders(scheduled, [
      r("a", 10, 100), // unchanged
      r("b", 10, 250), // moved
      r("d", 10, 400), // new
    ]);
    expect(removed.sort()).toEqual(["b:10", "c:10"]);
    expect(added.map((x) => x.eventId)).toEqual(["b", "d"]);
  });

  test("diffReminders is a no-op on identical input", () => {
    const scheduled = new Map([["a:10", 100]]);
    expect(diffReminders(scheduled, [r("a", 10, 100)])).toEqual({ added: [], removed: [] });
  });
});
