// @ts-expect-error Bun supplies its test module at runtime; the Convex
// TypeScript project intentionally does not include Bun's ambient types.
import { afterEach, describe, expect, test } from "bun:test";

import {
  fetchCalendarList,
  getCalendarEvent,
  GoogleApiError,
  insertCalendarEvent,
  mapGoogleEvent,
  patchCalendarEvent,
} from "../../../convex/integrations/google/client";

/** Capture the URL and parsed JSON body of the single request a write helper
 * makes, and answer it with `response`. */
function captureRequest(response: unknown) {
  const captured: { url: string; body: unknown } = { url: "", body: null };
  globalThis.fetch = (async (input, init) => {
    captured.url = String(input);
    captured.body = init?.body ? JSON.parse(String(init.body)) : null;
    return Response.json(response);
  }) as typeof fetch;
  return captured;
}

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

describe("GoogleApiError diagnostics", () => {
  test("retains the response body and status for operation-aware mapping", async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":{"reason":"backend timeout"}}', {
        status: 408,
        statusText: "Request Timeout",
      })) as typeof fetch;

    try {
      await getCalendarEvent("token", "primary@example.com", "event-1");
      throw new Error("expected getCalendarEvent to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleApiError);
      expect((error as GoogleApiError).status).toBe(408);
      expect((error as GoogleApiError).responseBody).toContain("backend timeout");
    }
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
    expect(mapped.conferenceUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(mapped.conferenceName).toBe("Google Meet");
    expect(mapped.conferenceType).toBe("hangoutsMeet");
    expect(mapped.recurringEventId).toBe("series-1");
    expect(mapped.attendees).toHaveLength(2);
  });

  test("maps an imported third-party video conference", () => {
    const mapped = mapGoogleEvent(
      {
        id: "evt-zoom",
        start: { dateTime: "2026-07-25T09:00:00.000Z" },
        end: { dateTime: "2026-07-25T09:30:00.000Z" },
        conferenceData: {
          conferenceSolution: {
            key: { type: "addOn" },
            name: "Zoom Meeting",
          },
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+15551234567" },
            {
              entryPointType: "video",
              uri: "https://zoom.us/j/123456789",
            },
          ],
        },
      },
      "primary@example.com",
    );

    expect(mapped.conferenceUrl).toBe("https://zoom.us/j/123456789");
    expect(mapped.conferenceName).toBe("Zoom Meeting");
    expect(mapped.conferenceType).toBe("addOn");
    expect(mapped.hangoutLink).toBeUndefined();
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
    // must not flatten them to false; the domain permission model applies the defaults.
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

const START = { dateTime: "2026-07-25T09:00:00.000Z" };
const END = { dateTime: "2026-07-25T09:30:00.000Z" };

describe("insertCalendarEvent conferencing", () => {
  test("requests a Meet link and bumps conferenceDataVersion", async () => {
    const captured = captureRequest({ id: "evt", start: START, end: END });

    await insertCalendarEvent(
      "token",
      "primary@example.com",
      { summary: "Sync", start: START, end: END },
      undefined,
      true,
    );

    expect(new URL(captured.url).searchParams.get("conferenceDataVersion")).toBe(
      "1",
    );
    const body = captured.body as {
      conferenceData?: { createRequest?: { conferenceSolutionKey?: unknown } };
    };
    expect(body.conferenceData?.createRequest?.conferenceSolutionKey).toEqual({
      type: "hangoutsMeet",
    });
  });

  test("omits conference data when not requested", async () => {
    const captured = captureRequest({ id: "evt", start: START, end: END });

    await insertCalendarEvent("token", "primary@example.com", {
      summary: "Sync",
      start: START,
      end: END,
    });

    expect(new URL(captured.url).searchParams.has("conferenceDataVersion")).toBe(
      false,
    );
    expect((captured.body as { conferenceData?: unknown }).conferenceData).toBe(
      undefined,
    );
  });

  test("passes stable event and conference IDs for retry reconciliation", async () => {
    const captured = captureRequest({ id: "qalistable", start: START, end: END });

    await insertCalendarEvent(
      "token",
      "primary@example.com",
      {
        id: "qalistable",
        summary: "Sync",
        start: START,
        end: END,
      },
      undefined,
      true,
      "stable-operation",
    );

    const body = captured.body as {
      id?: string;
      conferenceData?: { createRequest?: { requestId?: string } };
    };
    expect(body.id).toBe("qalistable");
    expect(body.conferenceData?.createRequest?.requestId).toBe(
      "stable-operation",
    );
  });
});

describe("patchCalendarEvent conferencing", () => {
  test("adds a Meet link on request", async () => {
    const captured = captureRequest({ id: "evt", start: START, end: END });

    await patchCalendarEvent(
      "token",
      "primary@example.com",
      "evt",
      { summary: "Sync" },
      undefined,
      "add",
    );

    expect(new URL(captured.url).searchParams.get("conferenceDataVersion")).toBe(
      "1",
    );
    expect(
      (captured.body as { conferenceData?: unknown }).conferenceData,
    ).toBeDefined();
  });

  test("clears the conference by sending null", async () => {
    const captured = captureRequest({ id: "evt", start: START, end: END });

    await patchCalendarEvent(
      "token",
      "primary@example.com",
      "evt",
      { summary: "Sync" },
      undefined,
      "remove",
    );

    expect(new URL(captured.url).searchParams.get("conferenceDataVersion")).toBe(
      "1",
    );
    expect(
      (captured.body as { conferenceData?: unknown }).conferenceData,
    ).toBeNull();
  });
});
