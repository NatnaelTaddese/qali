// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  hostEmailForTarget,
  withHostAttendee,
} from "../../../convex/domains/calendar/hostAttendee";

describe("withHostAttendee", () => {
  test("appends the host as an accepted guest after the invited guests", () => {
    expect(
      withHostAttendee([{ email: "guest@example.com" }], {
        email: "host@example.com",
        displayName: "Host",
      }),
    ).toEqual([
      { email: "guest@example.com" },
      { email: "host@example.com", displayName: "Host", responseStatus: "accepted" },
    ]);
  });

  test("leaves a guest-less event guest-less", () => {
    expect(withHostAttendee([], { email: "host@example.com" })).toEqual([]);
    expect(withHostAttendee(undefined, { email: "host@example.com" })).toBeUndefined();
  });

  test("skips the host when their email is unknown or not an email", () => {
    const guests = [{ email: "guest@example.com" }];
    expect(withHostAttendee(guests, {})).toEqual(guests);
    expect(withHostAttendee(guests, { email: "primary" })).toEqual(guests);
  });

  test("marks an already-invited host accepted instead of duplicating them", () => {
    expect(
      withHostAttendee(
        [{ email: "guest@example.com" }, { email: "Host@Example.com", displayName: "Me" }],
        { email: "host@example.com" },
      ),
    ).toEqual([
      { email: "guest@example.com" },
      { email: "Host@Example.com", displayName: "Me", responseStatus: "accepted" },
    ]);
    const declined = [{ email: "host@example.com", responseStatus: "declined" as const }];
    expect(withHostAttendee(declined, { email: "host@example.com" })).toEqual(declined);
  });
});

describe("hostEmailForTarget", () => {
  test("uses the primary calendar's id over a stale account stamp", () => {
    expect(
      hostEmailForTarget(
        { primary: true, providerCalendarId: "host@example.com" },
        { providerAccountId: "old@example.com" },
      ),
    ).toBe("host@example.com");
  });

  test("falls back to the connection's account email for an unsynced primary", () => {
    expect(
      hostEmailForTarget(
        { primary: true, providerCalendarId: "primary" },
        { providerAccountId: "host@example.com" },
      ),
    ).toBe("host@example.com");
    expect(
      hostEmailForTarget({ primary: true, providerCalendarId: "primary" }),
    ).toBeUndefined();
    expect(
      hostEmailForTarget(
        { primary: true, providerCalendarId: "primary" },
        { providerAccountId: "primary" },
      ),
    ).toBeUndefined();
  });

  test("never names a host on a secondary or shared calendar", () => {
    expect(
      hostEmailForTarget(
        { primary: false, providerCalendarId: "team@group.calendar.google.com" },
        { providerAccountId: "host@example.com" },
      ),
    ).toBeUndefined();
    expect(
      hostEmailForTarget(
        { providerCalendarId: "host@example.com" },
        { providerAccountId: "host@example.com" },
      ),
    ).toBeUndefined();
  });
});
