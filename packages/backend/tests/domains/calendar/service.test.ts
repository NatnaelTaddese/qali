// @ts-expect-error Bun supplies its test module at runtime.
import { afterEach, describe, expect, test } from "bun:test";

import { REMINDER_RULES } from "@qali/domain/reminders";

import type { Doc, Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import { GoogleCalendarAdapter } from "../../../convex/integrations/google/adapter";
import type {
  CalendarProviderAdapter,
  CreateEventRequest,
  DeleteEventRequest,
  ProviderEvent,
  UpdateEventRequest,
} from "../../../convex/integrations/calendar/types";
import { ProviderError } from "../../../convex/integrations/calendar/errors";

process.env.SKIP_ENV_VALIDATION = "1";
const service = await import("../../../convex/domains/calendar/service");
const {
  calendarActionEvent,
  truncateRecurrence,
} = service;

const dependencies = {
  getAdapter: async () => new GoogleCalendarAdapter("token"),
  refreshCalendar: async () => {},
};

const createEventOp = (
  ctx: ActionCtx,
  userId: string,
  _accessToken: string,
  args: Parameters<typeof service.createEventOp>[2],
) => service.createEventOp(ctx, userId, args, dependencies);
const updateEventOp = (
  ctx: ActionCtx,
  userId: string,
  _accessToken: string,
  args: Parameters<typeof service.updateEventOp>[2],
) => service.updateEventOp(ctx, userId, args, dependencies);
const respondToEventOp = (
  ctx: ActionCtx,
  userId: string,
  _accessToken: string,
  args: Parameters<typeof service.respondToEventOp>[2],
) => service.respondToEventOp(ctx, userId, args, dependencies);
const deleteEventOp = (
  ctx: ActionCtx,
  userId: string,
  _accessToken: string,
  args: Parameters<typeof service.deleteEventOp>[2],
) => service.deleteEventOp(ctx, userId, args, dependencies);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const PROVIDER_CALENDAR_ID = "primary@example.com";

function eventRow(overrides: Partial<Doc<"events">> = {}): Doc<"events"> {
  return {
    _id: "event-row" as Id<"events">,
    _creationTime: 1,
    userId: "user-1",
    summary: "Pay salary",
    startMs: Date.parse("2026-09-01T01:00:00.000Z"),
    endMs: Date.parse("2026-09-01T02:00:00.000Z"),
    allDay: false,
    status: "confirmed",
    organizer: { self: true },
    connectionId: "connection-1" as Id<"calendarConnections">,
    localCalendarId: "local-calendar-1" as Id<"calendars">,
    providerEventId: "google-event",
    providerUpdatedMs: Date.parse("2026-08-11T00:00:00.000Z"),
    ...overrides,
  };
}

function actionContext(
  row: Doc<"events">,
  accessRole = "owner",
  /** What the operation claim answers; a replay answers `state: "succeeded"`. */
  claim: Record<string, unknown> = { state: "claimed", reconcileOnly: false },
) {
  const mutations: Record<string, unknown>[] = [];
  const settles: Record<string, unknown>[] = [];
  const ctx = {
    runQuery: async () => [],
    runMutation: async (_reference: unknown, args: Record<string, unknown>) => {
      if (
        args.eventId === row._id &&
        args.userId === row.userId &&
        Object.keys(args).length === 2
      ) {
        return {
          event: row,
          calendar: {
            _id: row.localCalendarId,
            userId: row.userId,
            providerCalendarId: PROVIDER_CALENDAR_ID,
            connectionId: row.connectionId,
            selected: true,
            isShared: false,
            accessRole,
          },
          connectionId: row.connectionId,
          localCalendarId: row.localCalendarId,
          providerCalendarId: PROVIDER_CALENDAR_ID,
          providerEventId: row.providerEventId,
          providerSeriesId: row.providerSeriesId,
        };
      }
      if ("kind" in args && "idempotencyKey" in args) {
        return claim;
      }
      if ("status" in args && "attemptId" in args) {
        settles.push(args);
        return true;
      }
      mutations.push(args);
      return null;
    },
  } as unknown as ActionCtx;
  return { ctx, mutations, settles };
}

function liveGoogleEvent(row: Doc<"events">, overrides: Record<string, unknown> = {}) {
  return {
    id: row.providerEventId,
    summary: row.summary,
    status: row.status,
    updated: new Date(row.providerUpdatedMs!).toISOString(),
    organizer: { self: true },
    start: {
      dateTime: new Date(row.startMs).toISOString(),
      timeZone: "Asia/Shanghai",
    },
    end: {
      dateTime: new Date(row.endMs).toISOString(),
      timeZone: "Asia/Shanghai",
    },
    ...overrides,
  };
}

/** A context for createEventOp: target resolution and mirror writes are stubbed. */
function createContext() {
  const mutations: Record<string, unknown>[] = [];
  const ctx = {
    runQuery: async () => [],
    runMutation: async (_reference: unknown, args: Record<string, unknown>) => {
      if ("requestedCalendarId" in args) {
        return {
          connectionId: "connection-1",
          localCalendarId: "local-calendar-1",
          providerCalendarId: "primary@example.com",
          accountEmail: "owner@example.com",
        };
      }
      if ("kind" in args && "idempotencyKey" in args) {
        return { state: "claimed", reconcileOnly: false };
      }
      if ("status" in args && "attemptId" in args) return true;
      mutations.push(args);
      return null;
    },
  } as unknown as ActionCtx;
  return { ctx, mutations };
}

function createdGoogleEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "new-google-id",
    summary: "Sync review",
    status: "confirmed",
    updated: "2026-08-11T00:00:00.000Z",
    start: { dateTime: "2026-09-01T01:00:00.000Z", timeZone: "UTC" },
    end: { dateTime: "2026-09-01T02:00:00.000Z", timeZone: "UTC" },
    ...overrides,
  };
}

const CREATE_ARGS = {
  calendarId: "local-calendar-1" as Id<"calendars">,
  summary: "Sync review",
  startMs: Date.parse("2026-09-01T01:00:00.000Z"),
  endMs: Date.parse("2026-09-01T02:00:00.000Z"),
};

describe("event creation", () => {
  test("returns the provider-neutral public action DTO", () => {
    const result = calendarActionEvent({
      id: "provider-id",
      calendarId: "primary",
      startMs: 1,
      endMs: 2,
      allDay: false,
      status: "confirmed",
      updatedMs: 3,
      seriesId: "master-1",
      color: "5",
      busy: false,
    });
    expect(result).toMatchObject({
      providerEventId: "provider-id",
      providerCalendarId: "primary",
      providerUpdatedMs: 3,
      providerSeriesId: "master-1",
      color: "5",
      busy: false,
    });
    expect("id" in result).toBe(false);
    expect("updatedMs" in result).toBe(false);
    expect("googleEventId" in result).toBe(false);
    expect("transparency" in result).toBe(false);
  });
  test("routes a public create op through an injected non-Google adapter", async () => {
    const { ctx, mutations } = createContext();
    let requestedCalendarId: string | undefined;
    const fake = {
      provider: "microsoft",
      capabilities: {
        contacts: false,
        recurringEvents: true,
        attendeeMembershipUpdates: true,
        rsvp: true,
        removeSelf: true,
        conference: { create: true, add: true, remove: true },
        idempotentCreate: true,
        idempotentUpdate: true,
        idempotentResponse: true,
        idempotentDelete: true,
      },
      async createEvent(request: CreateEventRequest) {
        requestedCalendarId = request.calendarId;
        return {
          id: "ms-event-1",
          calendarId: request.calendarId,
          summary: request.event.summary,
          startMs: request.event.startMs,
          endMs: request.event.endMs,
          allDay: false,
          status: "confirmed",
          updatedMs: 1,
        };
      },
      async reconcileAmbiguousCreate() {
        return null;
      },
    } as unknown as CalendarProviderAdapter;

    const event = await service.createEventOp(ctx, "user-1", CREATE_ARGS, {
      getAdapter: async () => fake,
      refreshCalendar: async () => {},
    });

    expect(fake.provider).toBe("microsoft");
    expect(requestedCalendarId).toBe("primary@example.com");
    expect(event.id).toBe("ms-event-1");
    expect(mutations).toContainEqual(
      expect.objectContaining({
        connectionId: "connection-1",
        localCalendarId: "local-calendar-1",
        event: expect.objectContaining({ id: "ms-event-1" }),
      }),
    );
  });

  test("emails invitations only when the event has guests", async () => {
    const withGuests = createContext();
    let url = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body));
      return Response.json(createdGoogleEvent());
    }) as typeof fetch;
    const event = await createEventOp(withGuests.ctx, "user-1", "token", {
      ...CREATE_ARGS,
      attendees: [{ email: "guest@example.com" }],
    });
    expect(url).toContain("sendUpdates=all");
    expect(event.id).toBe("new-google-id");
    // The owner rides along as an accepted guest so Google lists them as the
    // organizer in the guest list, the way its own UI does.
    expect(body.attendees).toEqual([
      { email: "guest@example.com" },
      { email: "owner@example.com", responseStatus: "accepted" },
    ]);
    // The freshly created event is mirrored into the local table right away.
    expect(withGuests.mutations.length).toBeGreaterThan(0);

    const soloUrls: string[] = [];
    let soloBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      soloUrls.push(String(input));
      soloBody = JSON.parse(String(init?.body));
      return Response.json(createdGoogleEvent());
    }) as typeof fetch;
    await createEventOp(createContext().ctx, "user-1", "token", CREATE_ARGS);
    expect(soloUrls[0]).not.toContain("sendUpdates");
    // A guest-less event stays guest-less: no lone organizer entry.
    expect(soloBody.attendees).toBeUndefined();
  });

  test("treats a duplicate-id 409 as confirmation and re-reads the event", async () => {
    const { ctx } = createContext();
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      // A prior attempt with this operation id already created the event; the
      // client-selected id makes Google answer the retry with a 409, which is
      // positive confirmation rather than a failed create.
      if (method === "POST") {
        return Response.json({ error: { message: "duplicate" } }, { status: 409 });
      }
      return Response.json(createdGoogleEvent({ id: "op-derived-id" }));
    }) as typeof fetch;

    const event = await createEventOp(ctx, "user-1", "token", {
      ...CREATE_ARGS,
      operationId: "operation-1",
    });
    expect(methods).toEqual(["POST", "GET"]);
    expect(event.id).toBe("op-derived-id");
  });
});

describe("invitation response", () => {
  const guestRow = () =>
    eventRow({
      organizer: { self: false },
      attendees: [
        { email: "me@example.com", self: true, responseStatus: "needsAction" },
      ],
    });

  test("refuses to respond on a read-only calendar before calling Google", async () => {
    const { ctx } = actionContext(guestRow(), "reader");
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return Response.json({});
    }) as typeof fetch;

    await expect(
      respondToEventOp(ctx, "user-1", "token", {
        eventId: "event-row" as Id<"events">,
        responseStatus: "accepted",
      }),
    ).rejects.toThrow(/not a guest/i);
    expect(fetched).toBe(false);
  });

  test("a guest RSVP patches only the self attendee and notifies the organizer", async () => {
    const row = guestRow();
    const { ctx } = actionContext(row, "writer");
    const requests: { method: string; url: string; body?: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (input, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      requests.push({ method, url: String(input), body });
      return Response.json(
        liveGoogleEvent(row, {
          attendees: [
            { email: "me@example.com", self: true, responseStatus: "needsAction" },
            { email: "other@example.com" },
          ],
        }),
      );
    }) as typeof fetch;

    await respondToEventOp(ctx, "user-1", "token", {
      eventId: row._id,
      responseStatus: "accepted",
    });

    expect(requests.map((r) => r.method)).toEqual(["GET", "PATCH"]);
    const patch = requests[1]!;
    // A non-organizer answering tells the organizer.
    expect(patch.url).toContain("sendUpdates=all");
    const attendees = patch.body!.attendees as {
      email: string;
      self?: boolean;
      responseStatus?: string;
    }[];
    expect(attendees.find((a) => a.self)?.responseStatus).toBe("accepted");
    // The other guest's entry is preserved untouched (patch replaces the array).
    expect(attendees.find((a) => a.email === "other@example.com")).toBeTruthy();
  });

  test("the organizer answering their own event sends no guest mail", async () => {
    const row = eventRow({
      organizer: { self: true },
      attendees: [
        { email: "me@example.com", self: true, responseStatus: "needsAction" },
      ],
    });
    const { ctx } = actionContext(row, "owner");
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return Response.json(
        liveGoogleEvent(row, {
          attendees: [
            { email: "me@example.com", self: true, responseStatus: "needsAction" },
          ],
        }),
      );
    }) as typeof fetch;

    await respondToEventOp(ctx, "user-1", "token", {
      eventId: row._id,
      responseStatus: "tentative",
    });
    expect(urls[1]).toContain("sendUpdates=none");
  });
});

describe("single event recurrence conversion", () => {
  test("patches the event into a master and records the series", async () => {
    const row = eventRow();
    const { ctx, mutations } = actionContext(row);
    const requests: { method: string; body?: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (_input, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      requests.push({ method, body });
      if (method === "PATCH") {
        return Response.json(
          liveGoogleEvent(row, {
            updated: "2026-08-11T00:01:00.000Z",
            recurrence: ["RRULE:FREQ=MONTHLY"],
          }),
        );
      }
      return Response.json(liveGoogleEvent(row));
    }) as typeof fetch;

    await updateEventOp(ctx, row.userId, "access-token", {
      eventId: row._id,
      recurrence: ["RRULE:FREQ=MONTHLY"],
      timeZone: "Asia/Shanghai",
      operationId: "operation-1",
      expectedProviderUpdatedMs: row.providerUpdatedMs,
    });

    expect(requests.map((request) => request.method)).toEqual(["GET", "PATCH"]);
    expect(requests[1]?.body).toMatchObject({
      recurrence: ["RRULE:FREQ=MONTHLY"],
      start: {
        dateTime: "2026-09-01T01:00:00.000Z",
        timeZone: "Asia/Shanghai",
      },
      end: {
        dateTime: "2026-09-01T02:00:00.000Z",
        timeZone: "Asia/Shanghai",
      },
    });
    expect(mutations).toContainEqual(
      expect.objectContaining({
        userId: row.userId,
        connectionId: row.connectionId,
        localCalendarId: row.localCalendarId,
        providerEventId: row.providerEventId,
        recurrence: ["RRULE:FREQ=MONTHLY"],
        replacedEventId: row._id,
      }),
    );
  });

  test("rejects a stale proposal before patching Google", async () => {
    const row = eventRow();
    const { ctx } = actionContext(row);
    const methods: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json(
        liveGoogleEvent(row, {
          summary: "Changed elsewhere",
          updated: "2026-08-11T00:02:00.000Z",
        }),
      );
    }) as typeof fetch;

    await expect(
      updateEventOp(ctx, row.userId, "access-token", {
        eventId: row._id,
        recurrence: ["RRULE:FREQ=MONTHLY"],
        timeZone: "Asia/Shanghai",
        expectedProviderUpdatedMs: row.providerUpdatedMs,
      }),
    ).rejects.toThrow("changed after");
    expect(methods).toEqual(["GET"]);
  });

  test("does not replace the rule of an existing recurring instance", async () => {
    const row = eventRow({ providerSeriesId: "existing-master" });
    const { ctx } = actionContext(row);
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return Response.json({});
    }) as typeof fetch;

    await expect(
      updateEventOp(ctx, row.userId, "access-token", {
        eventId: row._id,
        recurrence: ["RRULE:FREQ=DAILY"],
        timeZone: "Asia/Shanghai",
      }),
    ).rejects.toThrow("already part");
    expect(fetched).toBe(false);
  });

  test("rejects conversion on a read-only calendar before Google is called", async () => {
    const row = eventRow();
    const { ctx } = actionContext(row, "reader");
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return Response.json({});
    }) as typeof fetch;

    await expect(
      updateEventOp(ctx, row.userId, "access-token", {
        eventId: row._id,
        recurrence: ["RRULE:FREQ=MONTHLY"],
        timeZone: "Asia/Shanghai",
      }),
    ).rejects.toThrow("read-only");
    expect(fetched).toBe(false);
  });
});

describe("scoped recurring updates through a non-Google adapter", () => {
  const recurringRow = () =>
    eventRow({
      startMs: Date.parse("2026-09-08T01:00:00.000Z"),
      endMs: Date.parse("2026-09-08T02:00:00.000Z"),
      providerSeriesId: "series-master",
    });
  const masterEvent = (): ProviderEvent => ({
    id: "series-master",
    calendarId: "primary@example.com",
    summary: "Planning",
    startMs: Date.parse("2026-09-01T01:00:00.000Z"),
    endMs: Date.parse("2026-09-01T02:00:00.000Z"),
    allDay: false,
    timeZone: "Asia/Shanghai",
    status: "confirmed",
    updatedMs: Date.parse("2026-08-11T00:00:00.000Z"),
    recurrence: ["RRULE:FREQ=WEEKLY"],
  });
  const capabilities = {
    contacts: false,
    recurringEvents: true,
    attendeeMembershipUpdates: true,
    rsvp: true,
    removeSelf: true,
    conference: { create: true, add: true, remove: true },
    idempotentCreate: true,
    idempotentUpdate: true,
    idempotentResponse: true,
    idempotentDelete: true,
  };

  test("shifts the recurring master by the occurrence delta", async () => {
    const row = recurringRow();
    const { ctx } = actionContext(row);
    let update: UpdateEventRequest | undefined;
    const adapter = {
      provider: "microsoft",
      capabilities,
      async getEvent() {
        return masterEvent();
      },
      async updateEvent(request: UpdateEventRequest) {
        update = request;
        return { ...masterEvent(), ...request.patch, updatedMs: 2 };
      },
    } as unknown as CalendarProviderAdapter;

    await service.updateEventOp(
      ctx,
      row.userId,
      {
        eventId: row._id,
        scope: "allEvents",
        startMs: row.startMs + 60 * 60_000,
        endMs: row.endMs + 60 * 60_000,
        timeZone: "Asia/Shanghai",
        operationId: "shift-operation",
      },
      { getAdapter: async () => adapter, refreshCalendar: async () => {} },
    );

    expect(update?.ref.eventId).toBe("series-master");
    expect(update?.patch).toMatchObject({
      startMs: masterEvent().startMs + 60 * 60_000,
      endMs: masterEvent().endMs + 60 * 60_000,
    });
  });

  test("creates a deterministic tail first and compensates a definitive truncation failure", async () => {
    const row = recurringRow();
    const { ctx } = actionContext(row);
    const order: string[] = [];
    let tailRequest: CreateEventRequest | undefined;
    let compensation: DeleteEventRequest | undefined;
    const adapter = {
      provider: "microsoft",
      capabilities,
      async getEvent() {
        return masterEvent();
      },
      async createEvent(request: CreateEventRequest) {
        order.push("create-tail");
        tailRequest = request;
        return {
          ...masterEvent(),
          id: "tail-series",
          startMs: row.startMs,
          endMs: row.endMs,
        };
      },
      async reconcileAmbiguousCreate() {
        return null;
      },
      async updateEvent(_request: UpdateEventRequest) {
        order.push("truncate-master");
        throw new ProviderError("validation", "rule rejected");
      },
      async deleteEvent(request: DeleteEventRequest) {
        order.push("delete-tail");
        compensation = request;
      },
    } as unknown as CalendarProviderAdapter;

    await expect(
      service.updateEventOp(
        ctx,
        row.userId,
        {
          eventId: row._id,
          scope: "thisAndFollowing",
          operationId: "split-operation",
        },
        { getAdapter: async () => adapter, refreshCalendar: async () => {} },
      ),
    ).rejects.toMatchObject({ kind: "validation" });

    expect(order).toEqual(["create-tail", "truncate-master", "delete-tail"]);
    expect(tailRequest?.idempotencyKey).toBe("split-operation:tail");
    expect(compensation).toMatchObject({
      ref: { eventId: "tail-series" },
      mode: "cancel",
      notify: "none",
    });
  });
});

describe("scoped recurring deletion", () => {
  const recurring = (overrides: Partial<Doc<"events">> = {}) =>
    eventRow({ providerSeriesId: "series-master", ...overrides });

  test("truncation replaces COUNT or UNTIL while retaining the rule", () => {
    expect(
      truncateRecurrence(
        ["RRULE:FREQ=WEEKLY;COUNT=12;BYDAY=TU"],
        Date.parse("2026-09-01T00:59:59.000Z"),
        false,
      ),
    ).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260901T005959Z",
    ]);
    expect(
      truncateRecurrence(
        ["RRULE:FREQ=DAILY;UNTIL=20261231", "EXDATE:20260812"],
        Date.parse("2026-09-01T00:00:00.000Z") - 1_000,
        true,
      ),
    ).toEqual([
      "RRULE:FREQ=DAILY;UNTIL=20260831",
      "EXDATE:20260812",
    ]);
  });

  test("deletes only the selected instance for thisEvent", async () => {
    const row = recurring();
    const { ctx, mutations } = actionContext(row);
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await deleteEventOp(ctx, row.userId, "access-token", {
      eventId: row._id,
      scope: "thisEvent",
    });

    expect(urls[0]).toContain("/events/google-event");
    expect(mutations).toContainEqual(
      expect.objectContaining({ eventId: row._id, userId: row.userId }),
    );
    expect(mutations.some((args) => args.providerSeriesId !== undefined)).toBe(
      false,
    );
  });

  test("deletes the master and clears series state for allEvents", async () => {
    const row = recurring();
    const { ctx, mutations } = actionContext(row);
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await deleteEventOp(ctx, row.userId, "access-token", {
      eventId: row._id,
      scope: "allEvents",
    });

    expect(urls[0]).toContain("/events/series-master");
    expect(mutations).toContainEqual(
      expect.objectContaining({
        eventId: row._id,
        userId: row.userId,
        connectionId: row.connectionId,
        localCalendarId: row.localCalendarId,
        providerSeriesId: "series-master",
      }),
    );
  });

  test("notifies guests only when the organizer deletes the series", async () => {
    const organizerRow = recurring({
      attendees: [{ email: "guest@example.com" }],
    });
    const organizerContext = actionContext(organizerRow);
    const organizerUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      organizerUrls.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await deleteEventOp(
      organizerContext.ctx,
      organizerRow.userId,
      "access-token",
      { eventId: organizerRow._id, scope: "allEvents" },
    );
    expect(organizerUrls[0]).toContain("sendUpdates=all");

    const guestRow = recurring({
      organizer: { self: false },
      attendees: [{ email: "me@example.com", self: true }],
    });
    const guestContext = actionContext(guestRow, "writer");
    const guestUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      guestUrls.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await deleteEventOp(guestContext.ctx, guestRow.userId, "access-token", {
      eventId: guestRow._id,
      scope: "allEvents",
    });
    expect(guestUrls[0]).toContain("sendUpdates=none");
  });

  test("truncates at a moved instance's original series position", async () => {
    const row = recurring({
      startMs: Date.parse("2026-09-03T01:00:00.000Z"),
      endMs: Date.parse("2026-09-03T02:00:00.000Z"),
    });
    const { ctx, mutations } = actionContext(row);
    const requests: { method: string; body?: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (input, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      requests.push({ method, body });
      const url = String(input);
      if (method === "PATCH") {
        return Response.json(
          liveGoogleEvent(row, {
            id: "series-master",
            updated: "2026-08-11T00:01:00.000Z",
            recurrence: [
              "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260901T005959Z",
            ],
          }),
        );
      }
      if (url.includes("/events/series-master")) {
        return Response.json(
          liveGoogleEvent(row, {
            id: "series-master",
            start: {
              dateTime: "2026-08-25T01:00:00.000Z",
              timeZone: "Asia/Shanghai",
            },
            end: {
              dateTime: "2026-08-25T02:00:00.000Z",
              timeZone: "Asia/Shanghai",
            },
            recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
          }),
        );
      }
      return Response.json(
        liveGoogleEvent(row, {
          originalStartTime: {
            dateTime: "2026-09-01T01:00:00.000Z",
            timeZone: "Asia/Shanghai",
          },
        }),
      );
    }) as typeof fetch;

    await deleteEventOp(ctx, row.userId, "access-token", {
      eventId: row._id,
      scope: "thisAndFollowing",
      expectedSeriesUpdatedMs: row.providerUpdatedMs,
    });

    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "PATCH",
    ]);
    expect(requests[3]?.body).toEqual({
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260901T005959Z"],
    });
    expect(mutations).toContainEqual(
      expect.objectContaining({
        providerEventId: "series-master",
        recurrence: [
          "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260901T005959Z",
        ],
      }),
    );
  });

  test("does not patch or notify again when the master is already truncated", async () => {
    const row = recurring();
    const { ctx } = actionContext(row);
    const methods: string[] = [];
    const truncated = "RRULE:FREQ=WEEKLY;UNTIL=20260901T005959Z";
    globalThis.fetch = (async (input, init) => {
      methods.push(init?.method ?? "GET");
      if (String(input).includes("/events/series-master")) {
        return Response.json(
          liveGoogleEvent(row, {
            id: "series-master",
            start: {
              dateTime: "2026-08-25T01:00:00.000Z",
              timeZone: "Asia/Shanghai",
            },
            end: {
              dateTime: "2026-08-25T02:00:00.000Z",
              timeZone: "Asia/Shanghai",
            },
            recurrence: [truncated],
          }),
        );
      }
      return Response.json(
        liveGoogleEvent(row, {
          originalStartTime: {
            dateTime: "2026-09-01T01:00:00.000Z",
            timeZone: "Asia/Shanghai",
          },
        }),
      );
    }) as typeof fetch;

    await deleteEventOp(ctx, row.userId, "access-token", {
      eventId: row._id,
      scope: "thisAndFollowing",
      expectedSeriesUpdatedMs: row.providerUpdatedMs! - 1,
    });

    expect(methods).toEqual(["GET", "GET"]);
  });

  test("rejects a stale future-only proposal before patching", async () => {
    const row = recurring();
    const { ctx } = actionContext(row);
    const methods: string[] = [];
    globalThis.fetch = (async (input, init) => {
      methods.push(init?.method ?? "GET");
      if (String(input).includes("/events/series-master")) {
        return Response.json(
          liveGoogleEvent(row, {
            id: "series-master",
            updated: "2026-08-11T00:05:00.000Z",
            start: {
              dateTime: "2026-08-25T01:00:00.000Z",
              timeZone: "Asia/Shanghai",
            },
            end: {
              dateTime: "2026-08-25T02:00:00.000Z",
              timeZone: "Asia/Shanghai",
            },
            recurrence: ["RRULE:FREQ=WEEKLY"],
          }),
        );
      }
      return Response.json(
        liveGoogleEvent(row, {
          originalStartTime: {
            dateTime: "2026-09-01T01:00:00.000Z",
            timeZone: "Asia/Shanghai",
          },
        }),
      );
    }) as typeof fetch;

    await expect(
      deleteEventOp(ctx, row.userId, "access-token", {
        eventId: row._id,
        scope: "thisAndFollowing",
        expectedSeriesUpdatedMs: row.providerUpdatedMs,
      }),
    ).rejects.toThrow("changed after");
    expect(methods).toEqual(["GET", "GET"]);
  });

  test("treats future deletion at the series head as allEvents", async () => {
    const row = recurring();
    const { ctx } = actionContext(row);
    const methods: string[] = [];
    const urls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      urls.push(String(input));
      if (method === "DELETE") return new Response(null, { status: 204 });
      const master = String(input).includes("/events/series-master");
      return Response.json(
        liveGoogleEvent(row, {
          id: master ? "series-master" : row.providerEventId,
          originalStartTime: master
            ? undefined
            : {
                dateTime: new Date(row.startMs).toISOString(),
                timeZone: "Asia/Shanghai",
              },
          recurrence: master ? ["RRULE:FREQ=WEEKLY"] : undefined,
        }),
      );
    }) as typeof fetch;

    await deleteEventOp(ctx, row.userId, "access-token", {
      eventId: row._id,
      scope: "thisAndFollowing",
    });

    expect(methods).toEqual(["GET", "GET", "DELETE"]);
    expect(urls[2]).toContain("/events/series-master");
  });

  test("rejects future-only removal by a guest before calling Google", async () => {
    const row = recurring({
      organizer: { self: false },
      attendees: [{ email: "guest@example.com", self: true }],
    });
    const { ctx } = actionContext(row, "writer");
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return Response.json({});
    }) as typeof fetch;

    await expect(
      deleteEventOp(ctx, row.userId, "access-token", {
        eventId: row._id,
        scope: "thisAndFollowing",
      }),
    ).rejects.toThrow("Only the organizer");
    expect(fetched).toBe(false);
  });

  test("cleans up a stale local occurrence when a future-only retry sees 404", async () => {
    const row = recurring();
    const { ctx, mutations } = actionContext(row);
    globalThis.fetch = (async () =>
      Response.json({ error: { message: "Not found" } }, { status: 404 })) as typeof fetch;

    await deleteEventOp(ctx, row.userId, "access-token", {
      eventId: row._id,
      scope: "thisAndFollowing",
    });

    expect(mutations).toContainEqual({
      eventId: row._id,
      userId: row.userId,
      connectionId: row.connectionId,
      localCalendarId: row.localCalendarId,
      providerSeriesId: undefined,
    });
  });

  test("rejects a future-only delete when the master has no RRULE", async () => {
    const row = recurring();
    const { ctx } = actionContext(row);
    globalThis.fetch = (async (input) => {
      if (String(input).includes("/events/series-master")) {
        return Response.json(
          liveGoogleEvent(row, {
            id: "series-master",
            start: {
              dateTime: "2026-08-25T01:00:00.000Z",
              timeZone: "Asia/Shanghai",
            },
            end: {
              dateTime: "2026-08-25T02:00:00.000Z",
              timeZone: "Asia/Shanghai",
            },
            recurrence: ["EXDATE:20260908T010000Z"],
          }),
        );
      }
      return Response.json(
        liveGoogleEvent(row, {
          originalStartTime: {
            dateTime: "2026-09-01T01:00:00.000Z",
            timeZone: "Asia/Shanghai",
          },
        }),
      );
    }) as typeof fetch;

    await expect(
      deleteEventOp(ctx, row.userId, "access-token", {
        eventId: row._id,
        scope: "thisAndFollowing",
      }),
    ).rejects.toThrow("no recurrence rule");
  });
});

describe("reminder writes are fitted to the adapter's rules", () => {
  const baseCapabilities = {
    contacts: false,
    recurringEvents: true,
    attendeeMembershipUpdates: true,
    rsvp: true,
    removeSelf: true,
    conference: { create: true, add: true, remove: true },
    idempotentCreate: true,
    idempotentUpdate: true,
    idempotentResponse: true,
    idempotentDelete: true,
  };

  function recordingAdapter(reminders: (typeof REMINDER_RULES)["google"]) {
    const patches: UpdateEventRequest[] = [];
    const adapter = {
      provider: "microsoft",
      capabilities: { ...baseCapabilities, reminders },
      async updateEvent(request: UpdateEventRequest) {
        patches.push(request);
        return {
          id: request.ref.eventId,
          calendarId: request.ref.calendarId,
          startMs: 1,
          endMs: 2,
          allDay: false,
          status: "confirmed",
          updatedMs: 1,
          reminders: request.patch.reminders ?? undefined,
        };
      },
    } as unknown as CalendarProviderAdapter;
    return { adapter, patches };
  }

  test("a single-reminder provider gets null materialised into the resolved default", async () => {
    const row = eventRow();
    const { ctx, mutations } = actionContext(row);
    const { adapter, patches } = recordingAdapter(REMINDER_RULES.microsoft);
    await service.updateEventOp(
      ctx,
      "user-1",
      { eventId: row._id, reminders: null },
      { getAdapter: async () => adapter, refreshCalendar: async () => {} },
    );
    // No preference, no calendar default → the domain's 10-minute default,
    // written explicitly because Graph has no "use default" on the wire.
    expect(patches[0]?.patch.reminders).toEqual([{ method: "popup", minutes: 10 }]);
    expect(mutations[mutations.length - 1]).toMatchObject({
      event: { reminders: [{ method: "popup", minutes: 10 }] },
    });
  });

  test("a single-reminder provider rejects two popups before the provider is called", async () => {
    const row = eventRow();
    const { ctx } = actionContext(row);
    const { adapter, patches } = recordingAdapter(REMINDER_RULES.microsoft);
    await expect(
      service.updateEventOp(
        ctx,
        "user-1",
        {
          eventId: row._id,
          reminders: [
            { method: "popup", minutes: 10 },
            { method: "popup", minutes: 60 },
          ],
        },
        { getAdapter: async () => adapter, refreshCalendar: async () => {} },
      ),
    ).rejects.toThrow("one reminder per event");
    expect(patches).toEqual([]);
  });

  test("a read-only feed refuses every reminder write", async () => {
    const row = eventRow();
    const { ctx } = actionContext(row);
    const { adapter, patches } = recordingAdapter(REMINDER_RULES.ical);
    await expect(
      service.updateEventOp(
        ctx,
        "user-1",
        { eventId: row._id, reminders: [{ method: "popup", minutes: 10 }] },
        { getAdapter: async () => adapter, refreshCalendar: async () => {} },
      ),
    ).rejects.toThrow("can't be changed");
    expect(patches).toEqual([]);
  });

  test("Google receives useDefault/overrides and the mirror keeps the neutral list", async () => {
    const row = eventRow();
    const { ctx, mutations } = actionContext(row);
    const bodies: Record<string, unknown>[] = [];
    // Google always returns a `reminders` object; the stub keeps the last
    // patched one so a later retry check sees the live state.
    let liveReminders: unknown = { useDefault: true };
    globalThis.fetch = (async (input, init) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        if (body.reminders !== undefined) liveReminders = body.reminders;
      }
      return Response.json(liveGoogleEvent(row, { reminders: liveReminders }));
    }) as typeof fetch;

    await updateEventOp(ctx, "user-1", "token", {
      eventId: row._id,
      reminders: [
        { method: "email", minutes: 1440 },
        { method: "popup", minutes: 10 },
      ],
    });
    expect(bodies[0]?.reminders).toEqual({
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 10 },
        { method: "email", minutes: 1440 },
      ],
    });
    expect(mutations[mutations.length - 1]).toMatchObject({
      event: {
        reminders: [
          { method: "popup", minutes: 10 },
          { method: "email", minutes: 1440 },
        ],
      },
    });

    // Back to the calendar default stays `null` for a provider that has one.
    await updateEventOp(ctx, "user-1", "token", {
      eventId: row._id,
      reminders: null,
    });
    expect(bodies[1]?.reminders).toEqual({ useDefault: true });
  });
});

describe("reminders from the detail panel", () => {
  const TEN = [{ method: "popup" as const, minutes: 10 }];
  const THIRTY = [{ method: "popup" as const, minutes: 30 }];
  const MASTER = "series-master";
  const guestRow = () =>
    eventRow({
      organizer: { self: false },
      attendees: [
        { email: "me@example.com", self: true, responseStatus: "accepted" },
      ],
    });
  const seriesRow = () =>
    eventRow({
      providerSeriesId: MASTER,
      providerEventId: `${MASTER}_20260901T010000Z`,
    });

  /**
   * Records what it is asked to write. Reminders are kept per provider event
   * id, and an occurrence with none of its own reads the series master's, as
   * Google's expanded instances do.
   */
  function fakeAdapter(
    options: {
      rules?: (typeof REMINDER_RULES)["google"];
      own?: Record<string, ProviderEvent["reminders"]>;
      missing?: string[];
    } = {},
  ) {
    const updates: UpdateEventRequest[] = [];
    const reads: string[] = [];
    const stored = new Map(Object.entries(options.own ?? {}));
    const missing = new Set(options.missing ?? []);
    let failure: unknown;
    const find = (id: string): ProviderEvent => {
      if (missing.has(id)) throw new ProviderError("not-found", "Event not found");
      return {
        id,
        calendarId: PROVIDER_CALENDAR_ID,
        startMs: 1,
        endMs: 2,
        allDay: false,
        status: "confirmed",
        updatedMs: 1,
        reminders: stored.has(id) ? stored.get(id) : stored.get(MASTER),
      };
    };
    const adapter = {
      provider: "google",
      capabilities: {
        contacts: false,
        recurringEvents: true,
        attendeeMembershipUpdates: true,
        rsvp: true,
        removeSelf: true,
        conference: { create: true, add: true, remove: true },
        idempotentCreate: true,
        idempotentUpdate: true,
        idempotentResponse: true,
        idempotentDelete: true,
        reminders: options.rules ?? REMINDER_RULES.google,
      },
      async getEvent(ref: { eventId: string }) {
        reads.push(ref.eventId);
        return find(ref.eventId);
      },
      async updateEvent(request: UpdateEventRequest) {
        updates.push(request);
        if (failure) throw failure;
        find(request.ref.eventId);
        stored.set(request.ref.eventId, request.patch.reminders ?? undefined);
        return find(request.ref.eventId);
      },
    } as unknown as CalendarProviderAdapter;
    return {
      adapter,
      updates,
      reads,
      failWith(error: unknown) {
        failure = error;
      },
    };
  }

  function deps(adapter: CalendarProviderAdapter, refresh?: () => Promise<void>) {
    let refreshes = 0;
    return {
      dependencies: {
        getAdapter: async () => adapter,
        refreshCalendar: async () => {
          refreshes += 1;
          await refresh?.();
        },
      },
      refreshCount: () => refreshes,
    };
  }

  const mirrored = (mutations: Record<string, unknown>[]) =>
    mutations.filter((m) => "event" in m);

  test("a guest sets reminders on an invitation they can't otherwise edit", async () => {
    const row = guestRow();
    const { ctx, mutations } = actionContext(row, "writer");
    const { adapter, updates } = fakeAdapter();
    const { dependencies } = deps(adapter);

    // The general edit path still turns the guest away…
    await expect(
      service.updateEventOp(
        ctx,
        "user-1",
        { eventId: row._id, reminders: TEN },
        dependencies,
      ),
    ).rejects.toThrow(/only the organiser/i);
    expect(updates).toEqual([]);

    // …while the reminders-only path patches exactly the reminders, quietly.
    await service.setEventRemindersOp(
      ctx,
      "user-1",
      { eventId: row._id, reminders: TEN },
      dependencies,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.ref.eventId).toBe(row.providerEventId);
    expect(updates[0]!.patch).toEqual({ reminders: TEN });
    expect(updates[0]!.notify).toBeUndefined();
    // No key: it would buy a read-before-write that can skip a needed write.
    expect(updates[0]!.idempotencyKey).toBeUndefined();
    expect(mutations[mutations.length - 1]).toMatchObject({
      event: { reminders: TEN },
    });
  });

  test("a read-only calendar is refused before the provider is called", async () => {
    const row = guestRow();
    const { ctx } = actionContext(row, "reader");
    const { adapter, updates } = fakeAdapter();
    await expect(
      service.setEventRemindersOp(
        ctx,
        "user-1",
        { eventId: row._id, reminders: TEN },
        deps(adapter).dependencies,
      ),
    ).rejects.toThrow(/can't change reminders/);
    expect(updates).toEqual([]);
  });

  test("a working location is refused; it has no reminders to set", async () => {
    const row = eventRow({ eventType: "workingLocation" });
    const { ctx } = actionContext(row, "owner");
    const { adapter, updates } = fakeAdapter();
    await expect(
      service.setEventRemindersOp(
        ctx,
        "user-1",
        { eventId: row._id, reminders: TEN },
        deps(adapter).dependencies,
      ),
    ).rejects.toThrow(/can't change reminders/);
    expect(updates).toEqual([]);
  });

  test("a series-wide write goes to the master, and the opened occurrence is mirrored at once", async () => {
    const row = seriesRow();
    const { ctx, mutations } = actionContext(row, "owner");
    const { adapter, updates, reads } = fakeAdapter();
    const { dependencies, refreshCount } = deps(adapter);

    await service.setEventRemindersOp(
      ctx,
      "user-1",
      { eventId: row._id, reminders: TEN, scope: "allEvents" },
      dependencies,
    );
    // One write, to the master; the occurrence inherited it and is only read.
    expect(updates.map((u) => u.ref.eventId)).toEqual([MASTER]);
    expect(updates[0]!.patch).toEqual({ reminders: TEN });
    expect(reads).toEqual([row.providerEventId]);
    // The refresh can be skipped under a held sync lease, so the row the user
    // is looking at doesn't wait for it; and the master is never a row.
    expect(mirrored(mutations)).toHaveLength(1);
    expect(mirrored(mutations)[0]).toMatchObject({
      event: { id: row.providerEventId, reminders: TEN },
    });
    expect(refreshCount()).toBe(1);
  });

  test("an occurrence with its own override is written too", async () => {
    const row = seriesRow();
    const { ctx, mutations } = actionContext(row, "owner");
    const { adapter, updates } = fakeAdapter({
      own: { [row.providerEventId]: THIRTY },
    });

    await service.setEventRemindersOp(
      ctx,
      "user-1",
      { eventId: row._id, reminders: TEN, scope: "allEvents" },
      deps(adapter).dependencies,
    );
    // The master's change never reaches an exception, so it gets its own write.
    expect(updates.map((u) => u.ref.eventId)).toEqual([
      MASTER,
      row.providerEventId,
    ]);
    expect(mirrored(mutations)[0]).toMatchObject({ event: { reminders: TEN } });
  });

  test("a master that isn't on this calendar falls back to the occurrence", async () => {
    // A guest invited to a single occurrence of someone else's series.
    const row = seriesRow();
    const { ctx, mutations, settles } = actionContext(row, "owner");
    const { adapter, updates } = fakeAdapter({ missing: [MASTER] });
    const { dependencies, refreshCount } = deps(adapter);

    await service.setEventRemindersOp(
      ctx,
      "user-1",
      { eventId: row._id, reminders: TEN, scope: "allEvents" },
      dependencies,
    );
    expect(updates.map((u) => u.ref.eventId)).toEqual([
      MASTER,
      row.providerEventId,
    ]);
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ status: "succeeded" });
    expect(mirrored(mutations)[0]).toMatchObject({ event: { reminders: TEN } });
    // Nothing series-wide changed, so there is nothing to refresh.
    expect(refreshCount()).toBe(0);
  });

  test("without a scope only this occurrence changes", async () => {
    const row = seriesRow();
    const { ctx, mutations } = actionContext(row, "owner");
    const { adapter, updates } = fakeAdapter();
    const { dependencies, refreshCount } = deps(adapter);

    await service.setEventRemindersOp(
      ctx,
      "user-1",
      { eventId: row._id, reminders: TEN },
      dependencies,
    );
    expect(updates.map((u) => u.ref.eventId)).toEqual([row.providerEventId]);
    expect(refreshCount()).toBe(0);
    expect(mirrored(mutations)).toHaveLength(1);
  });

  test("a replayed operation writes nothing again, and still lands the row", async () => {
    const row = seriesRow();
    const { ctx, mutations, settles } = actionContext(row, "owner", {
      state: "succeeded",
      reconcileOnly: false,
      providerEventId: MASTER,
    });
    // The first attempt already reached the provider.
    const { adapter, updates, reads } = fakeAdapter({ own: { [MASTER]: TEN } });
    const { dependencies, refreshCount } = deps(adapter);

    await service.setEventRemindersOp(
      ctx,
      "user-1",
      { eventId: row._id, reminders: TEN, scope: "allEvents" },
      dependencies,
    );
    expect(updates).toEqual([]);
    // Settled the first time round; and it is the occurrence that is read and
    // mirrored, never the master the operation recorded.
    expect(settles).toEqual([]);
    expect(reads).toEqual([row.providerEventId]);
    expect(mirrored(mutations)).toHaveLength(1);
    expect(mirrored(mutations)[0]).toMatchObject({
      event: { id: row.providerEventId, reminders: TEN },
    });
    expect(refreshCount()).toBe(1);
  });

  test("a refresh that fails after the write is a committed write, not a failure", async () => {
    const row = seriesRow();
    const { ctx, mutations, settles } = actionContext(row, "owner");
    const { adapter, updates } = fakeAdapter();
    const { dependencies } = deps(adapter, async () => {
      throw new Error("sync token expired");
    });

    await expect(
      service.setEventRemindersOp(
        ctx,
        "user-1",
        { eventId: row._id, reminders: TEN, scope: "allEvents" },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(service.ExternalWriteCommittedError);
    expect(updates).toHaveLength(1);
    expect(settles[settles.length - 1]).toMatchObject({ status: "succeeded" });
    expect(mirrored(mutations)).toHaveLength(1);
  });

  test("the provider's reminder rules still apply", async () => {
    const row = guestRow();
    const { ctx } = actionContext(row, "writer");
    const { adapter, updates } = fakeAdapter({ rules: REMINDER_RULES.microsoft });
    await expect(
      service.setEventRemindersOp(
        ctx,
        "user-1",
        { eventId: row._id, reminders: [...TEN, { method: "popup", minutes: 60 }] },
        deps(adapter).dependencies,
      ),
    ).rejects.toThrow("one reminder per event");
    expect(updates).toEqual([]);
  });

  test("a provider refusal settles the attempt and surfaces the error", async () => {
    const row = guestRow();
    const { ctx, mutations, settles } = actionContext(row, "writer");
    const { adapter, failWith } = fakeAdapter();
    failWith(new ProviderError("validation", "Reminder offset out of range"));
    await expect(
      service.setEventRemindersOp(
        ctx,
        "user-1",
        { eventId: row._id, reminders: TEN },
        deps(adapter).dependencies,
      ),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(settles[settles.length - 1]).toMatchObject({ status: "failed" });
    expect(mirrored(mutations)).toEqual([]);
  });
});
