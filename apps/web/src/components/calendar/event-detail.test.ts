// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

process.env.SKIP_ENV_VALIDATION = "1";
const { recurringDeleteScopes } = await import("./event-detail");

describe("recurring event delete scopes", () => {
  test("organizers can choose occurrence, future, or whole series", () => {
    expect(recurringDeleteScopes(true).map((option) => option.scope)).toEqual([
      "thisEvent",
      "thisAndFollowing",
      "allEvents",
    ]);
  });

  test("guests can remove one occurrence or their whole series copy", () => {
    expect(recurringDeleteScopes(false).map((option) => option.scope)).toEqual([
      "thisEvent",
      "allEvents",
    ]);
  });

  test("scope choices contain no second-step confirmation state", () => {
    expect(
      recurringDeleteScopes(true).every(
        (option) => !("confirmLabel" in option),
      ),
    ).toBe(true);
  });
});
