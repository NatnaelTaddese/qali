// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
  shouldToggleSearchShortcut,
  stepActiveResult,
} from "./search-interactions";

describe("search interactions", () => {
  const chord = {
    key: "k",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
  };

  test("⌘K opens search unless a text field would lose the chord", () => {
    expect(
      shouldToggleSearchShortcut(chord, {
        searchOpen: false,
        editableTarget: false,
      }),
    ).toBe(true);
    expect(
      shouldToggleSearchShortcut(chord, {
        searchOpen: false,
        editableTarget: true,
      }),
    ).toBe(false);
    // Once open, the chord closes it from its own input.
    expect(
      shouldToggleSearchShortcut(chord, {
        searchOpen: true,
        editableTarget: true,
      }),
    ).toBe(true);
  });

  test("ignores consumed, alt-modified, and unmodified K", () => {
    const options = { searchOpen: false, editableTarget: false };
    expect(
      shouldToggleSearchShortcut({ ...chord, defaultPrevented: true }, options),
    ).toBe(false);
    expect(
      shouldToggleSearchShortcut({ ...chord, altKey: true }, options),
    ).toBe(false);
    expect(
      shouldToggleSearchShortcut({ ...chord, metaKey: false }, options),
    ).toBe(false);
    expect(
      shouldToggleSearchShortcut(
        { ...chord, metaKey: false, ctrlKey: true },
        options,
      ),
    ).toBe(true);
  });

  test("arrow keys wrap around the result list", () => {
    expect(stepActiveResult(0, 3, 1)).toBe(1);
    expect(stepActiveResult(2, 3, 1)).toBe(0);
    expect(stepActiveResult(0, 3, -1)).toBe(2);
    expect(stepActiveResult(0, 0, 1)).toBe(0);
  });
});
