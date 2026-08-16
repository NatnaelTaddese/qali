// @ts-expect-error Bun supplies its test module at runtime.
import { afterEach, describe, expect, test } from "bun:test";

import { GoogleCalendarAdapter } from "./adapter";
import { encodePageCursor, encodeSyncCursor } from "./mappers";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function rawEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    summary: "Planning",
    status: "confirmed",
    updated: "2026-08-11T00:00:00.000Z",
    start: {
      dateTime: "2026-09-01T01:00:00.000Z",
      timeZone: "Asia/Shanghai",
    },
    end: {
      dateTime: "2026-09-01T02:00:00.000Z",
      timeZone: "Asia/Shanghai",
    },
    ...overrides,
  };
}

function requestLog(response: (method: string, url: URL, body: unknown) => Response) {
  const requests: { method: string; url: URL; body: unknown }[] = [];
  globalThis.fetch = (async (input, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const url = new URL(String(input));
    requests.push({ method, url, body });
    return response(method, url, body);
  }) as typeof fetch;
  return requests;
}

describe("GoogleCalendarAdapter capabilities and sync", () => {
  test("declares the optional behaviors it implements", () => {
    const capabilities = new GoogleCalendarAdapter("token").capabilities;
    expect(capabilities.conference).toEqual({
      create: true,
      add: true,
      remove: true,
    });
    expect(capabilities.attendeeMembershipUpdates).toBe(true);
    expect(capabilities.rsvp).toBe(true);
    expect(capabilities.removeSelf).toBe(true);
    expect(capabilities.idempotentUpdate).toBe(true);
    expect(capabilities.idempotentResponse).toBe(true);
    expect(capabilities.idempotentDelete).toBe(true);
  });

  test("keeps committed and page cursors separate and maps expanded metadata", async () => {
    const requests = requestLog(() =>
      Response.json({
        items: [
          rawEvent({
            recurringEventId: "master-1",
            originalStartTime: {
              dateTime: "2026-08-25T01:00:00.000Z",
              timeZone: "Asia/Shanghai",
            },
          }),
        ],
        nextPageToken: "next-page",
        nextSyncToken: "next-sync",
      }),
    );

    const page = await new GoogleCalendarAdapter("token").listEvents({
      calendarId: "primary@example.com",
      syncCursor: encodeSyncCursor("legacy-raw-sync-token"),
      pageCursor: encodePageCursor("current-page"),
      fromMs: 1,
      toMs: 2,
    });

    expect(requests[0]?.url.searchParams.get("syncToken")).toBe(
      "legacy-raw-sync-token",
    );
    expect(requests[0]?.url.searchParams.get("pageToken")).toBe("current-page");
    expect(requests[0]?.url.searchParams.has("timeMin")).toBe(false);
    expect(String(page.nextPageCursor)).toBe("next-page");
    expect(String(page.commitCursor)).toBe("next-sync");
    expect(page.items[0]).toMatchObject({
      seriesId: "master-1",
      originalOccurrenceStartMs: Date.parse("2026-08-25T01:00:00.000Z"),
      timeZone: "Asia/Shanghai",
    });
  });

  test("uses the bounded window only for a full sync", async () => {
    const requests = requestLog(() => Response.json({ items: [] }));
    await new GoogleCalendarAdapter("token").listEvents({
      calendarId: "primary@example.com",
      syncCursor: null,
      fromMs: 1_000,
      toMs: 2_000,
    });
    expect(requests[0]?.url.searchParams.get("timeMin")).toBe(
      new Date(1_000).toISOString(),
    );
    expect(requests[0]?.url.searchParams.get("timeMax")).toBe(
      new Date(2_000).toISOString(),
    );
  });

  test("treats HTTP 410 as cursor expiry only during sync", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: "gone" }, { status: 410 })) as typeof fetch;
    const adapter = new GoogleCalendarAdapter("token");
    await expect(
      adapter.listEvents({
        calendarId: "primary@example.com",
        syncCursor: encodeSyncCursor("expired"),
        fromMs: 0,
        toMs: 1,
      }),
    ).rejects.toMatchObject({ kind: "cursor-expired" });
    await expect(
      adapter.getEvent({ calendarId: "primary@example.com", eventId: "gone" }),
    ).rejects.toMatchObject({ kind: "not-found" });
  });
});

describe("GoogleCalendarAdapter create and patch", () => {
  test("uses one stable operation key for event and conference creation", async () => {
    const requests = requestLog(() =>
      Response.json(
        rawEvent({
          id: "qalioperation1",
          recurrence: ["RRULE:FREQ=WEEKLY"],
        }),
      ),
    );
    const created = await new GoogleCalendarAdapter("token").createEvent({
      calendarId: "primary@example.com",
      idempotencyKey: "operation-1",
      event: {
        summary: "Planning",
        startMs: Date.parse("2026-09-01T01:00:00.000Z"),
        endMs: Date.parse("2026-09-01T02:00:00.000Z"),
        recurrence: ["RRULE:FREQ=WEEKLY"],
        conference: "add",
        timeZone: "Asia/Shanghai",
      },
    });

    const body = requests[0]?.body as {
      id?: string;
      conferenceData?: { createRequest?: { requestId?: string } };
    };
    expect(body.id).toBe("qalioperation1");
    expect(body.conferenceData?.createRequest?.requestId).toBe("operation-1");
    expect(created.recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
    expect(created.seriesId).toBeUndefined();
  });

  test("sends explicit null clears and preserves conferencing when requested", async () => {
    const requests = requestLog(() => Response.json(rawEvent()));
    await new GoogleCalendarAdapter("token").updateEvent({
      ref: { calendarId: "primary@example.com", eventId: "event-1" },
      patch: {
        description: null,
        location: null,
        color: null,
        visibility: null,
        conference: "preserve",
      },
    });

    expect(requests[0]?.body).toMatchObject({
      description: null,
      location: null,
      colorId: null,
      visibility: null,
    });
    expect(requests[0]?.url.searchParams.has("conferenceDataVersion")).toBe(false);
    expect(
      (requests[0]?.body as { conferenceData?: unknown }).conferenceData,
    ).toBeUndefined();
  });

  test("adds and removes conferencing with explicit semantics", async () => {
    const requests = requestLog((method) => {
      if (method === "GET") return Response.json(rawEvent());
      return Response.json(rawEvent());
    });
    const adapter = new GoogleCalendarAdapter("token");
    await adapter.updateEvent({
      ref: { calendarId: "primary@example.com", eventId: "event-1" },
      patch: { conference: "add" },
      idempotencyKey: "conference-operation",
    });
    await adapter.updateEvent({
      ref: { calendarId: "primary@example.com", eventId: "event-1" },
      patch: { conference: "remove" },
    });

    const patches = requests.filter((request) => request.method === "PATCH");
    expect(patches[0]?.url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(
      (patches[0]?.body as { conferenceData?: { createRequest?: { requestId?: string } } })
        .conferenceData?.createRequest?.requestId,
    ).toBe("conference-operation");
    expect((patches[1]?.body as { conferenceData?: unknown }).conferenceData).toBeNull();
  });

  test("an operation-key retry no-ops when its semantic patch already landed", async () => {
    const requests = requestLog(() => Response.json(rawEvent({ summary: "Landed" })));
    const event = await new GoogleCalendarAdapter("token").updateEvent({
      ref: { calendarId: "primary@example.com", eventId: "event-1" },
      patch: { summary: "Landed" },
      idempotencyKey: "update-operation",
    });
    expect(event.summary).toBe("Landed");
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
  });

  test("rejects invalid time pairs before making a provider call", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return Response.json(rawEvent());
    }) as typeof fetch;
    await expect(
      new GoogleCalendarAdapter("token").updateEvent({
        ref: { calendarId: "primary@example.com", eventId: "event-1" },
        patch: { startMs: 1 },
      }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(fetched).toBe(false);
  });

  test("classifies a write timeout as ambiguous", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: "timed out" }, { status: 408 })) as typeof fetch;
    await expect(
      new GoogleCalendarAdapter("token").updateEvent({
        ref: { calendarId: "primary@example.com", eventId: "event-1" },
        patch: { summary: "Maybe landed" },
        idempotencyKey: undefined,
      }),
    ).rejects.toMatchObject({ kind: "ambiguous", retryable: false });
  });
});

describe("GoogleCalendarAdapter attendee membership", () => {
  test("preserves live attendees added after the caller's local snapshot", async () => {
    const requests = requestLog((method, _url, body) =>
      Response.json(
        method === "PATCH"
          ? rawEvent({ attendees: (body as { attendees: unknown }).attendees })
          : rawEvent({
              attendees: [
                { email: "owner@example.com", organizer: true },
                { email: "remove@example.com" },
                { email: "concurrent@example.com", comment: "Added elsewhere" },
              ],
            }),
      ),
    );

    await new GoogleCalendarAdapter("token").updateEvent({
      ref: { calendarId: "primary@example.com", eventId: "event-1" },
      patch: { attendees: [] },
      knownAttendeeEmails: ["owner@example.com", "remove@example.com"],
    });

    const attendees = (requests[1]?.body as { attendees: Record<string, unknown>[] })
      .attendees;
    expect(attendees).toContainEqual({
      email: "concurrent@example.com",
      comment: "Added elsewhere",
    });
    expect(attendees.some((attendee) => attendee.email === "remove@example.com")).toBe(
      false,
    );
  });

  test("merges desired membership into full live objects without stripping raw fields", async () => {
    const updated = Date.parse("2026-08-11T00:00:00.000Z");
    const live = rawEvent({
      attendees: [
        { email: "owner@example.com", organizer: true, responseStatus: "accepted" },
        {
          email: "room@example.com",
          resource: true,
          responseStatus: "accepted",
          comment: "Projector",
        },
        { email: "removed@example.com", responseStatus: "tentative" },
      ],
    });
    const requests = requestLog((method, _url, body) =>
      Response.json(method === "PATCH" ? rawEvent({ attendees: (body as { attendees: unknown }).attendees }) : live),
    );

    await new GoogleCalendarAdapter("token").updateEvent({
      ref: { calendarId: "primary@example.com", eventId: "event-1" },
      patch: {
        attendees: [
          { email: "room@example.com" },
          { email: "new@example.com", optional: true },
        ],
      },
      expectedUpdatedMs: updated,
    });

    const attendees = (requests[1]?.body as { attendees: Record<string, unknown>[] })
      .attendees;
    expect(attendees).toContainEqual({
      email: "room@example.com",
      resource: true,
      responseStatus: "accepted",
      comment: "Projector",
    });
    expect(attendees).toContainEqual({
      email: "owner@example.com",
      organizer: true,
      responseStatus: "accepted",
    });
    expect(attendees).toContainEqual({ email: "new@example.com", optional: true });
    expect(attendees.some((attendee) => attendee.email === "removed@example.com")).toBe(
      false,
    );
  });

  test("rejects provider-partial and stale attendee lists without patching", async () => {
    const adapter = new GoogleCalendarAdapter("token");
    let requests = requestLog(() =>
      Response.json(rawEvent({ attendeesOmitted: true, attendees: [] })),
    );
    await expect(
      adapter.updateEvent({
        ref: { calendarId: "primary@example.com", eventId: "event-1" },
        patch: { attendees: [] },
      }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(requests.map((request) => request.method)).toEqual(["GET"]);

    requests = requestLog(() => Response.json(rawEvent({ attendees: [] })));
    await expect(
      adapter.updateEvent({
        ref: { calendarId: "primary@example.com", eventId: "event-1" },
        patch: { attendees: [] },
        expectedUpdatedMs: 1,
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
  });
});

describe("GoogleCalendarAdapter RSVP and delete", () => {
  test("RSVP preserves raw attendees and patches only self", async () => {
    const live = rawEvent({
      attendees: [
        {
          email: "me@example.com",
          self: true,
          responseStatus: "needsAction",
          comment: "Bringing one guest",
          additionalGuests: 1,
        },
        { email: "room@example.com", resource: true, responseStatus: "accepted" },
      ],
    });
    const requests = requestLog((method, _url, body) =>
      Response.json(method === "PATCH" ? rawEvent(body as Record<string, unknown>) : live),
    );
    await new GoogleCalendarAdapter("token").respondToEvent({
      ref: { calendarId: "primary@example.com", eventId: "event-1" },
      responseStatus: "accepted",
      idempotencyKey: "rsvp-operation",
    });
    const attendees = (requests[1]?.body as { attendees: Record<string, unknown>[] })
      .attendees;
    expect(attendees[0]).toMatchObject({
      self: true,
      responseStatus: "accepted",
      comment: "Bringing one guest",
      additionalGuests: 1,
    });
    expect(attendees[1]).toEqual({
      email: "room@example.com",
      resource: true,
      responseStatus: "accepted",
    });
  });

  test("RSVP no-ops when self already has the requested response", async () => {
    const requests = requestLog(() =>
      Response.json(
        rawEvent({
          attendees: [
            { email: "me@example.com", self: true, responseStatus: "accepted" },
          ],
        }),
      ),
    );
    await new GoogleCalendarAdapter("token").respondToEvent({
      ref: { calendarId: "primary@example.com", eventId: "event-1" },
      responseStatus: "accepted",
    });
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
  });

  test("RSVP rejects partial lists and events without a self attendee", async () => {
    const adapter = new GoogleCalendarAdapter("token");
    let requests = requestLog(() =>
      Response.json(
        rawEvent({
          attendeesOmitted: true,
          attendees: [{ email: "me@example.com", self: true }],
        }),
      ),
    );
    await expect(
      adapter.respondToEvent({
        ref: { calendarId: "primary@example.com", eventId: "event-1" },
        responseStatus: "declined",
      }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(requests).toHaveLength(1);

    requests = requestLog(() =>
      Response.json(rawEvent({ attendees: [{ email: "other@example.com" }] })),
    );
    await expect(
      adapter.respondToEvent({
        ref: { calendarId: "primary@example.com", eventId: "event-1" },
        responseStatus: "declined",
      }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(requests).toHaveLength(1);
  });

  test("delete intent controls notifications and repeated 404 is success", async () => {
    let call = 0;
    const requests = requestLog(() => {
      call += 1;
      return call === 3
        ? Response.json({ error: "missing" }, { status: 404 })
        : new Response(null, { status: 204 });
    });
    const adapter = new GoogleCalendarAdapter("token");
    const ref = { calendarId: "primary@example.com", eventId: "event-1" };
    await adapter.deleteEvent({
      ref,
      mode: "remove-self",
      notify: "all",
      idempotencyKey: "remove-operation",
    });
    await adapter.deleteEvent({
      ref,
      mode: "cancel",
      notify: "all",
      idempotencyKey: "cancel-operation",
    });
    await adapter.deleteEvent({ ref, mode: "cancel", idempotencyKey: "retry" });

    expect(requests[0]?.url.searchParams.get("sendUpdates")).toBe("none");
    expect(requests[1]?.url.searchParams.get("sendUpdates")).toBe("all");
  });
});
