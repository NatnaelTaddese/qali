// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  GoogleApiError,
  GoogleNetworkError,
  SyncTokenExpiredError,
  type MappedEvent,
} from "../../../convex/integrations/google/client";
import {
  decodePageCursor,
  decodeSyncCursor,
  encodePageCursor,
  encodeSyncCursor,
  toProviderError,
  toProviderEvent,
} from "../../../convex/integrations/google/mappers";

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
      {
        recurrence: ["RRULE:FREQ=WEEKLY"],
        start: { dateTime: "2026-07-25T09:00:00.000Z", timeZone: "Asia/Shanghai" },
      },
    );

    expect(event.id).toBe("g-evt");
    expect(event.updatedMs).toBe(500);
    expect(event.seriesId).toBe("series-1");
    expect(event.recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
    expect(event.timeZone).toBe("Asia/Shanghai");
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

  test("maps an expanded instance's original series position", () => {
    const event = toProviderEvent(
      mappedEvent({ recurringEventId: "master-1" }),
      {
        start: { dateTime: "2026-09-03T01:00:00.000Z" },
        originalStartTime: {
          dateTime: "2026-09-01T01:00:00.000Z",
          timeZone: "Asia/Shanghai",
        },
      },
    );
    expect(event.seriesId).toBe("master-1");
    expect(event.originalOccurrenceStartMs).toBe(
      Date.parse("2026-09-01T01:00:00.000Z"),
    );
    expect(event.timeZone).toBe("Asia/Shanghai");
    expect(event.recurrence).toBeUndefined();
  });
});

describe("toProviderError", () => {
  const cases: [unknown, Parameters<typeof toProviderError>[1], string, boolean][] = [
    [new SyncTokenExpiredError(), "sync", "cursor-expired", false],
    [new SyncTokenExpiredError(), "read", "not-found", false],
    [new GoogleNetworkError(new Error("socket")), "read", "transient", true],
    [new GoogleNetworkError(new Error("socket")), "update", "ambiguous", false],
    [new GoogleApiError(410, "gone"), "sync", "cursor-expired", false],
    [new GoogleApiError(410, "gone"), "read", "not-found", false],
    [new GoogleApiError(409, "dup"), "create", "conflict", false],
    [new GoogleApiError(403, "forbidden"), "read", "permission", false],
    [new GoogleApiError(404, "missing"), "read", "not-found", false],
    [new GoogleApiError(401, "unauth"), "read", "authentication", false],
    [new GoogleApiError(400, "bad"), "create", "validation", false],
    [new GoogleApiError(408, "timeout"), "read", "transient", true],
    [new GoogleApiError(408, "timeout"), "update", "ambiguous", false],
    [new GoogleApiError(429, "slow down"), "create", "rate-limited", true],
    [new GoogleApiError(503, "down"), "sync", "transient", true],
    [new GoogleApiError(503, "down"), "create", "ambiguous", false],
    ["nope", "read", "transient", true],
    ["nope", "respond", "ambiguous", false],
  ];

  for (const [input, operation, kind, retryable] of cases) {
    test(`${operation}: ${kind} (retryable=${retryable})`, () => {
      const mapped = toProviderError(input, operation);
      expect(mapped.kind).toBe(kind);
      expect(mapped.retryable).toBe(retryable);
    });
  }

  test("a lost response is ambiguous, not transient — reconcile, don't blind-retry", () => {
    const mapped = toProviderError(new GoogleNetworkError(new Error("x")), "create");
    expect(mapped.kind).toBe("ambiguous");
    expect(mapped.retryable).toBe(false);
  });

  test("classifies Google's 403 rate-limit reason and retains its body", () => {
    const source = new GoogleApiError(
      403,
      "Google API 403: quota",
      '{"reason":"rateLimitExceeded","detail":"daily project quota"}',
      2_000,
    );
    const mapped = toProviderError(source, "update");
    expect(mapped.kind).toBe("rate-limited");
    expect(mapped.retryAfterMs).toBe(2_000);
    expect((mapped.options.cause as GoogleApiError).responseBody).toContain(
      "daily project quota",
    );
  });
});

describe("opaque cursor codec", () => {
  test("round-trips page and committed sync tokens independently", () => {
    expect(decodePageCursor(encodePageCursor("p1"))).toBe("p1");
    expect(decodeSyncCursor(encodeSyncCursor("s1"))).toBe("s1");
  });

  test("accepts a legacy raw Google sync token without JSON parsing failure", () => {
    expect(decodeSyncCursor("legacy-google-token" as ReturnType<typeof encodeSyncCursor>)).toBe(
      "legacy-google-token",
    );
  });

  test("accepts the superseded JSON sync envelope", () => {
    expect(
      decodeSyncCursor('{"s":"old-wrapped-token"}' as ReturnType<typeof encodeSyncCursor>),
    ).toBe("old-wrapped-token");
  });
});
