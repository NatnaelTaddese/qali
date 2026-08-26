// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import { shiftRecurringMasterRange } from "../../../convex/domains/calendar/recurrence";

describe("recurring event type changes", () => {
  const zone = "America/New_York";

  test("keeps a requested wall time when winter occurrence edits a summer master", () => {
    const shifted = shiftRecurringMasterRange({
      occurrenceStartMs: Date.UTC(2026, 0, 15),
      occurrenceEndMs: Date.UTC(2026, 0, 16),
      occurrenceAllDay: true,
      masterStartMs: Date.UTC(2026, 6, 15),
      masterEndMs: Date.UTC(2026, 6, 16),
      masterAllDay: true,
      targetStartMs: Date.UTC(2026, 0, 15, 14), // 9am EST
      targetEndMs: Date.UTC(2026, 0, 15, 15),
      targetAllDay: false,
      timeZone: zone,
    });

    expect(new Date(shifted.startMs).toISOString()).toBe(
      "2026-07-15T13:00:00.000Z",
    );
    expect(shifted.endMs - shifted.startMs).toBe(60 * 60 * 1000);
  });

  test("converts a timed summer master to its local all-day date", () => {
    const shifted = shiftRecurringMasterRange({
      occurrenceStartMs: Date.UTC(2026, 0, 15, 14),
      occurrenceEndMs: Date.UTC(2026, 0, 15, 15),
      occurrenceAllDay: false,
      masterStartMs: Date.UTC(2026, 6, 15, 13),
      masterEndMs: Date.UTC(2026, 6, 15, 14),
      masterAllDay: false,
      targetStartMs: Date.UTC(2026, 0, 15),
      targetEndMs: Date.UTC(2026, 0, 16),
      targetAllDay: true,
      timeZone: zone,
    });

    expect(new Date(shifted.startMs).toISOString()).toBe(
      "2026-07-15T00:00:00.000Z",
    );
    expect(new Date(shifted.endMs).toISOString()).toBe(
      "2026-07-16T00:00:00.000Z",
    );
  });
});
