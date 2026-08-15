// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  GoogleApiError,
  GoogleNetworkError,
  SyncTokenExpiredError,
  type MappedEvent,
} from "../../lib/google";
import {
  decodeCursor,
  encodeCursor,
  providerEventToMapped,
  toProviderError,
  toProviderEvent,
} from "./mappers";

function mappedEvent(overrides: Partial<MappedEvent> = {}): MappedEvent {
  return {
    googleEventId: "g-evt",
    calendarId: "primary",
    startMs: 1_000,
    endMs: 2_000,
    allDay: false,
    status: "confirmed",
    googleUpdatedMs: 500,
    ...overrides,
  };
}

describe("toProviderEvent", () => {
  test("renames Google-shaped fields and folds conference metadata", () => {
    const event = toProviderEvent(
      mappedEvent({
        summary: "Sync",
        transparency: "transparent",
        recurringEventId: "series-1",
        hangoutLink: "https://meet.example/abc",
        conferenceType: "hangoutsMeet",
        attendees: [
          { email: "me@x.com", self: true, responseStatus: "needsAction" },
        ],
      }),
    );

    expect(event.id).toBe("g-evt");
    expect(event.updatedMs).toBe(500);
    expect(event.seriesId).toBe("series-1");
    // transparency:"transparent" means the organizer marked it free.
    expect(event.busy).toBe(false);
    expect(event.conference).toEqual({
      url: "https://meet.example/abc",
      name: undefined,
      type: "hangoutsMeet",
    });
    expect(event.attendees?.[0]?.responseStatus).toBe("needsAction");
    // No Google-shaped keys survive on the neutral shape.
    expect("googleEventId" in event).toBe(false);
    expect("googleUpdatedMs" in event).toBe(false);
  });

  test("leaves busy undefined when transparency is absent (Google's default)", () => {
    expect(toProviderEvent(mappedEvent()).busy).toBeUndefined();
  });

  test("normalizes an unknown status to confirmed", () => {
    expect(toProviderEvent(mappedEvent({ status: "weird" })).status).toBe(
      "confirmed",
    );
    expect(toProviderEvent(mappedEvent({ status: "cancelled" })).status).toBe(
      "cancelled",
    );
  });
});

describe("providerEventToMapped (reverse map)", () => {
  test("round-trips a mapped event through the neutral shape and back", () => {
    const original = mappedEvent({
      summary: "Sync",
      description: "notes",
      location: "Room 1",
      transparency: "transparent",
      colorId: "5",
      recurringEventId: "series-9",
      conferenceUrl: "https://meet.example/xyz",
      conferenceType: "hangoutsMeet",
      attendees: [
        { email: "me@x.com", self: true, responseStatus: "accepted" },
        { email: "guest@x.com", optional: true },
      ],
      guestsCanModify: false,
    });

    const back = providerEventToMapped(toProviderEvent(original));

    expect(back.googleEventId).toBe("g-evt");
    expect(back.googleUpdatedMs).toBe(500);
    expect(back.transparency).toBe("transparent");
    expect(back.colorId).toBe("5");
    expect(back.recurringEventId).toBe("series-9");
    expect(back.conferenceUrl).toBe("https://meet.example/xyz");
    expect(back.hangoutLink).toBe("https://meet.example/xyz"); // hangoutsMeet
    expect(back.attendees).toEqual(original.attendees);
    expect(back.summary).toBe("Sync");
  });

  test("busy/transparency mapping survives the round trip", () => {
    // Absent transparency stays absent (Google's busy default), not invented.
    expect(providerEventToMapped(toProviderEvent(mappedEvent())).transparency).toBeUndefined();
    expect(
      providerEventToMapped(toProviderEvent(mappedEvent({ transparency: "opaque" })))
        .transparency,
    ).toBe("opaque");
  });
});

describe("toProviderError", () => {
  const cases: [unknown, string, boolean][] = [
    [new SyncTokenExpiredError(), "cursor-expired", false],
    [new GoogleNetworkError(new Error("socket")), "ambiguous", false],
    [new GoogleApiError(410, "gone"), "cursor-expired", false],
    [new GoogleApiError(409, "dup"), "conflict", false],
    [new GoogleApiError(403, "forbidden"), "permission", false],
    [new GoogleApiError(404, "missing"), "not-found", false],
    [new GoogleApiError(401, "unauth"), "authentication", false],
    [new GoogleApiError(400, "bad"), "validation", false],
    [new GoogleApiError(429, "slow down"), "rate-limited", true],
    [new GoogleApiError(503, "down"), "transient", true],
    ["nope", "transient", true],
  ];

  for (const [input, kind, retryable] of cases) {
    test(`${kind} (retryable=${retryable})`, () => {
      const mapped = toProviderError(input);
      expect(mapped.kind).toBe(kind);
      expect(mapped.retryable).toBe(retryable);
    });
  }

  test("a lost response is ambiguous, not transient — reconcile, don't blind-retry", () => {
    const mapped = toProviderError(new GoogleNetworkError(new Error("x")));
    expect(mapped.kind).toBe("ambiguous");
    expect(mapped.retryable).toBe(false);
  });
});

describe("opaque cursor codec", () => {
  test("round-trips a page token and a sync token independently", () => {
    expect(decodeCursor(encodeCursor({ pageToken: "p1" }))).toEqual({
      pageToken: "p1",
      syncToken: undefined,
    });
    expect(decodeCursor(encodeCursor({ syncToken: "s1" }))).toEqual({
      pageToken: undefined,
      syncToken: "s1",
    });
  });

  test("carries both a sync token and a page token (a delta pass continuation)", () => {
    expect(
      decodeCursor(encodeCursor({ pageToken: "p1", syncToken: "s1" })),
    ).toEqual({ pageToken: "p1", syncToken: "s1" });
  });
});
