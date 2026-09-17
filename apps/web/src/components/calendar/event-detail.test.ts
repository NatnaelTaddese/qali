// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

process.env.SKIP_ENV_VALIDATION = "1";
const { recurringDeleteScopes, removeControlLabels } = await import(
  "./event-detail"
);

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

describe("the footer's delete control label", () => {
  test("an organiser deletes the event outright", () => {
    expect(removeControlLabels({ canDelete: true, canEdit: true })).toEqual({
      label: "Delete",
      fullLabel: "Delete",
    });
  });

  test("a guest is told it is only their own copy", () => {
    expect(removeControlLabels({ canDelete: false, canEdit: false })).toEqual({
      label: "Remove from my calendar",
      fullLabel: "Remove from my calendar",
    });
  });

  test("beside Edit the label shortens and keeps the full wording aside", () => {
    // A guest with guestsCanModify gets Edit too; the long form then
    // overflows a phone-width dock.
    expect(removeControlLabels({ canDelete: false, canEdit: true })).toEqual({
      label: "Remove",
      fullLabel: "Remove from my calendar",
    });
  });
});
