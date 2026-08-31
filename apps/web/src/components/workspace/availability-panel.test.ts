// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

process.env.SKIP_ENV_VALIDATION = "1";
const { bookingSaveBlockedReason } = await import("./availability-panel");

/** A draft that saves cleanly, so each case below changes exactly one thing. */
const ok = {
  saving: false,
  openRuleCount: 5,
  slug: "nat",
  slugUnchanged: false,
  check: { available: true, reason: null },
} as const;

describe("bookingSaveBlockedReason", () => {
  test("says nothing when the draft is savable", () => {
    expect(bookingSaveBlockedReason({ ...ok })).toBeNull();
  });

  test("stays quiet mid-save so the spinner speaks instead", () => {
    expect(bookingSaveBlockedReason({ ...ok, saving: true })).toBeNull();
  });

  test("names the closed week before anything else", () => {
    expect(bookingSaveBlockedReason({ ...ok, openRuleCount: 0 })).toBe(
      "Open at least one day",
    );
  });

  test("reports a slug the mutation would reject, in its own words", () => {
    expect(bookingSaveBlockedReason({ ...ok, slug: "na" })).toBe(
      "Use at least 3 characters",
    );
    expect(bookingSaveBlockedReason({ ...ok, slug: "settings" })).toBe(
      "That name is reserved",
    );
  });

  // An unchanged slug skips the availability query, so a pending `check` there
  // is the steady state, not a wait.
  test("does not wait on a check that will never run", () => {
    expect(
      bookingSaveBlockedReason({
        ...ok,
        slugUnchanged: true,
        check: undefined,
      }),
    ).toBeNull();
  });

  test("waits on an availability check that is still in flight", () => {
    expect(bookingSaveBlockedReason({ ...ok, check: undefined })).toBe(
      "Checking that link name…",
    );
  });

  test("passes the server's reason through when the name is taken", () => {
    expect(
      bookingSaveBlockedReason({
        ...ok,
        check: { available: false, reason: "That link is already taken" },
      }),
    ).toBe("That link is already taken");
  });

  test("falls back to its own copy when the server gives no reason", () => {
    expect(
      bookingSaveBlockedReason({
        ...ok,
        check: { available: false, reason: null },
      }),
    ).toBe("That link name is taken");
  });
});
