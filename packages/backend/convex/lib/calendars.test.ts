// @ts-expect-error Bun supplies its test module at runtime; the Convex
// TypeScript project intentionally does not include Bun's ambient types.
import { describe, expect, test } from "bun:test";

import { isSharedPublicCalendar } from "./calendars";

describe("isSharedPublicCalendar", () => {
  test("holiday calendars are shared (byte-identical for everyone)", () => {
    expect(
      isSharedPublicCalendar("en.usa#holiday@group.v.calendar.google.com"),
    ).toBe(true);
    expect(
      isSharedPublicCalendar("en.uk#holiday@group.v.calendar.google.com"),
    ).toBe(true);
    expect(
      isSharedPublicCalendar(
        "en.christian#holiday@group.v.calendar.google.com",
      ),
    ).toBe(true);
  });

  test("birthday/contacts calendars are NOT shared (personalized)", () => {
    // Birthday calendars are derived from the viewer's own contacts, so their
    // contents differ per user and must never land in userless sharedEvents.
    expect(
      isSharedPublicCalendar("#contacts@group.v.calendar.google.com"),
    ).toBe(false);
    expect(
      isSharedPublicCalendar(
        "addressbook#contacts@group.v.calendar.google.com",
      ),
    ).toBe(false);
  });

  test("user-created secondary calendars are NOT shared", () => {
    // Secondary calendars get a random-hash id under the same domain but their
    // contents are owner-specific.
    expect(
      isSharedPublicCalendar(
        "abc123def456@group.v.calendar.google.com",
      ),
    ).toBe(false);
    expect(
      isSharedPublicCalendar(
        "c_1a2b3c4d5e6f7g8h@group.v.calendar.google.com",
      ),
    ).toBe(false);
  });

  test("primary and ordinary email-address calendars are NOT shared", () => {
    expect(isSharedPublicCalendar("primary")).toBe(false);
    expect(isSharedPublicCalendar("alice@gmail.com")).toBe(false);
    expect(isSharedPublicCalendar("team@example.com")).toBe(false);
  });

  test("does not match a spoofed suffix embedded elsewhere", () => {
    // The marker must be the real trailing segment, not a lookalike inside the
    // local part of another calendar's address.
    expect(
      isSharedPublicCalendar(
        "#holiday@group.v.calendar.google.com.evil.com",
      ),
    ).toBe(false);
  });
});
