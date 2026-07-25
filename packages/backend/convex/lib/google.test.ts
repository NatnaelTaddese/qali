// @ts-expect-error Bun supplies its test module at runtime; the Convex
// TypeScript project intentionally does not include Bun's ambient types.
import { afterEach, describe, expect, test } from "bun:test";

import { fetchCalendarList, mapGoogleEvent } from "./google";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchCalendarList", () => {
  test("paginates and maps non-hidden calendar metadata", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      const pageToken = new URL(url).searchParams.get("pageToken");
      if (!pageToken) {
        return Response.json({
          items: [
            {
              id: "primary@example.com",
              summary: "Primary",
              summaryOverride: "My calendar",
              backgroundColor: "#123456",
              foregroundColor: "#ffffff",
              primary: true,
              accessRole: "owner",
              timeZone: "Asia/Shanghai",
              selected: true,
            },
            { id: "hidden@example.com", hidden: true },
            { id: "deleted@example.com", deleted: true },
          ],
          nextPageToken: "next-page",
        });
      }
      return Response.json({
        items: [
          {
            id: "team@example.com",
            summary: "Team",
            accessRole: "reader",
            selected: false,
          },
        ],
      });
    }) as typeof fetch;

    const calendars = await fetchCalendarList("access-token");

    expect(calendars).toEqual([
      {
        googleCalendarId: "primary@example.com",
        summary: "Primary",
        summaryOverride: "My calendar",
        backgroundColor: "#123456",
        foregroundColor: "#ffffff",
        primary: true,
        accessRole: "owner",
        timeZone: "Asia/Shanghai",
        googleSelected: true,
      },
      {
        googleCalendarId: "team@example.com",
        summary: "Team",
        summaryOverride: undefined,
        backgroundColor: undefined,
        foregroundColor: undefined,
        primary: undefined,
        accessRole: "reader",
        timeZone: undefined,
        googleSelected: false,
      },
    ]);
    expect(requestedUrls).toHaveLength(2);
    expect(new URL(requestedUrls[0]).searchParams.get("showHidden")).toBe(
      "false",
    );
    expect(new URL(requestedUrls[1]).searchParams.get("pageToken")).toBe(
      "next-page",
    );
  });
});

describe("mapGoogleEvent", () => {
  test("maps a timed event with an organizer and guests", () => {
    const mapped = mapGoogleEvent(
      {
        id: "evt-1",
        summary: "Standup",
        start: { dateTime: "2026-07-25T09:00:00.000Z" },
        end: { dateTime: "2026-07-25T09:30:00.000Z" },
        updated: "2026-07-24T12:00:00.000Z",
        organizer: { email: "lead@example.com", displayName: "Lead" },
        creator: { email: "me@example.com", self: true },
        hangoutLink: "https://meet.google.com/abc-defg-hij",
        recurringEventId: "series-1",
        attendees: [
          { email: "me@example.com", self: true, responseStatus: "accepted" },
          { email: "lead@example.com", organizer: true },
        ],
      },
      "primary@example.com",
    );

    expect(mapped.allDay).toBe(false);
    expect(mapped.startMs).toBe(Date.parse("2026-07-25T09:00:00.000Z"));
    expect(mapped.endMs).toBe(Date.parse("2026-07-25T09:30:00.000Z"));
    expect(mapped.googleUpdatedMs).toBe(Date.parse("2026-07-24T12:00:00.000Z"));
    expect(mapped.organizer).toEqual({
      email: "lead@example.com",
      displayName: "Lead",
      self: undefined,
    });
    expect(mapped.creator?.self).toBe(true);
    expect(mapped.hangoutLink).toBe("https://meet.google.com/abc-defg-hij");
    expect(mapped.recurringEventId).toBe("series-1");
    expect(mapped.attendees).toHaveLength(2);
  });

  test("treats a date-only start as all-day", () => {
    const mapped = mapGoogleEvent(
      { id: "evt-2", start: { date: "2026-07-25" }, end: { date: "2026-07-26" } },
      "primary@example.com",
    );

    expect(mapped.allDay).toBe(true);
    expect(mapped.startMs).toBe(Date.UTC(2026, 6, 25));
    // Google's all-day end is exclusive: the day after the last day.
    expect(mapped.endMs).toBe(Date.UTC(2026, 6, 26));
    expect(mapped.status).toBe("confirmed");
  });

  test("leaves absent guest permissions undefined rather than coercing them", () => {
    // The three flags have *different* Google defaults when absent, so mapping
    // must not flatten them to false — lib/permissions.ts applies the defaults.
    const mapped = mapGoogleEvent(
      { id: "evt-3", start: { dateTime: "2026-07-25T09:00:00.000Z" } },
      "primary@example.com",
    );

    expect(mapped.guestsCanModify).toBeUndefined();
    expect(mapped.guestsCanInviteOthers).toBeUndefined();
    expect(mapped.guestsCanSeeOtherGuests).toBeUndefined();
    expect(mapped.locked).toBeUndefined();
    // A missing end falls back to the start, so the event is never negative.
    expect(mapped.endMs).toBe(mapped.startMs);
  });

  test("drops an empty organizer object and attendees without an email", () => {
    const mapped = mapGoogleEvent(
      {
        id: "evt-4",
        eventType: "birthday",
        organizer: {},
        start: { date: "2026-07-25" },
        end: { date: "2026-07-26" },
        attendees: [{ displayName: "Meeting room" }],
      },
      "primary@example.com",
    );

    expect(mapped.organizer).toBeUndefined();
    expect(mapped.attendees).toBeUndefined();
    expect(mapped.eventType).toBe("birthday");
  });
});
