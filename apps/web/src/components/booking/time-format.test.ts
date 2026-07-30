// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { formatTime } from "./time-format";

// Construct times in the runner's local zone so the assertions don't depend on
// where the test runs — the same read the picker makes.
const morning = new Date(2026, 6, 15, 9, 5).getTime();
const afternoon = new Date(2026, 6, 15, 13, 0).getTime();
const midnight = new Date(2026, 6, 15, 0, 30).getTime();

describe("formatTime", () => {
  test("24-hour is zero-padded HH:mm", () => {
    expect(formatTime(morning, true)).toBe("09:05");
    expect(formatTime(afternoon, true)).toBe("13:00");
    expect(formatTime(midnight, true)).toBe("00:30");
  });

  test("12-hour carries an AM/PM suffix", () => {
    expect(formatTime(morning, false)).toBe("9:05 AM");
    expect(formatTime(afternoon, false)).toBe("1:00 PM");
    expect(formatTime(midnight, false)).toBe("12:30 AM");
  });
});
