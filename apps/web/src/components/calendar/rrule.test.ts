// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { parseRRule, summarize } from "./rrule";

/** A fixed working zone so the assertions don't depend on the machine's. */
const TZ = "America/New_York";

function summary(rule: string): string | null {
  const recurrence = parseRRule([rule], TZ);
  return recurrence ? summarize(recurrence, TZ) : null;
}

describe("parseRRule", () => {
  test("describes a daily rule with an end date", () => {
    expect(summary("RRULE:FREQ=DAILY;UNTIL=20260826T235959Z")).toBe(
      "Daily · until Aug 26, 2026",
    );
  });

  test("reads a Google-normalized UTC UNTIL back as the authored day", () => {
    // Google emits end-of-day in the rule's own zone as a UTC instant; a
    // New-York "ends Aug 26" arrives as 03:59:59Z the next day.
    expect(summary("RRULE:FREQ=DAILY;UNTIL=20260827T035959Z")).toBe(
      "Daily · until Aug 26, 2026",
    );
  });

  test("describes weekly days in display order", () => {
    expect(summary("RRULE:FREQ=WEEKLY;BYDAY=WE,MO")).toBe(
      "Weekly on Mon, Wed",
    );
  });

  test("describes intervals and occurrence counts", () => {
    expect(summary("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=5")).toBe(
      "Every 2 weeks on Fri · 5 times",
    );
  });

  test("ignores non-rule recurrence lines", () => {
    const recurrence = parseRRule(
      ["EXDATE:20260812T090000Z", "RRULE:FREQ=MONTHLY"],
      TZ,
    );
    expect(recurrence && summarize(recurrence, TZ)).toBe("Monthly");
  });

  test("rejects malformed or unsupported rules", () => {
    expect(parseRRule(["RRULE:FREQ=DAILY;INTERVAL=0"], TZ)).toBeNull();
    expect(parseRRule(["RRULE:FREQ=MONTHLY;BYDAY=1MO"], TZ)).toBeNull();
    expect(parseRRule(["RRULE:FREQ=DAILY;UNTIL=20260230"], TZ)).toBeNull();
    expect(parseRRule(["RDATE:20260826T090000Z"], TZ)).toBeNull();
  });
});
