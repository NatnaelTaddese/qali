// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import { ProviderError } from "./errors";
import { createEventReconciling } from "./service";
import type {
  CalendarProviderAdapter,
  CreateEventRequest,
  EventCreate,
  EventPatch,
  EventRef,
  NotifyScope,
  PageCursor,
  ProviderCalendar,
  ProviderEvent,
  SyncCursor,
  SyncPage,
} from "./types";

/**
 * An in-memory adapter that is deliberately nothing like Google: its ids are
 * `fk-N`, it has no sync tokens or client-assigned ids, and it reconciles an
 * ambiguous create purely from the app-minted idempotency key it was handed. If
 * the neutral service works against this, the service holds no Google assumptions.
 */
class FakeCalendarAdapter implements CalendarProviderAdapter {
  readonly provider = "microsoft" as const; // not google, on purpose
  readonly capabilities = {
    contacts: false,
    recurringEvents: true,
    attendeeMembershipUpdates: true,
    rsvp: true,
    removeSelf: true,
    conference: { create: false, add: false, remove: false },
    idempotentCreate: true,
    idempotentUpdate: true,
    idempotentResponse: true,
    idempotentDelete: true,
  };

  private seq = 0;
  private readonly events = new Map<string, ProviderEvent>();
  private readonly byKey = new Map<string, string>();
  private cursorsValid = true;

  constructor(
    private readonly opts: {
      readOnlyCalendars?: Set<string>;
      /** Make the next create record the event but then throw, simulating a
       * landed-but-lost response (ambiguous) or an already-exists (conflict). */
      nextCreateThrows?: "ambiguous" | "conflict";
      /** Like above but the event does NOT land — reconcile must find nothing. */
      nextCreateThrowsWithoutLanding?: "ambiguous";
    } = {},
  ) {}

  expireCursors() {
    this.cursorsValid = false;
  }

  private land(request: CreateEventRequest): ProviderEvent {
    const id = `fk-${++this.seq}`;
    const event: ProviderEvent = {
      id,
      calendarId: request.calendarId,
      summary: request.event.summary,
      description: request.event.description,
      startMs: request.event.startMs ?? 0,
      endMs: request.event.endMs ?? 0,
      allDay: request.event.allDay ?? false,
      status: "confirmed",
      updatedMs: this.seq,
      attendees: request.event.attendees?.map((a) => ({
        email: a.email,
        self: true,
        responseStatus: "needsAction",
      })),
      recurrence: request.event.recurrence,
      timeZone: request.event.timeZone,
    };
    this.events.set(id, event);
    if (request.idempotencyKey) this.byKey.set(request.idempotencyKey, id);
    return event;
  }

  async listCalendars(): Promise<readonly ProviderCalendar[]> {
    return [{ id: "cal", writable: true }];
  }

  async listEvents(args: {
    calendarId: string;
    syncCursor: SyncCursor | null;
    pageCursor?: PageCursor | null;
    fromMs: number;
    toMs: number;
  }): Promise<SyncPage<ProviderEvent>> {
    if (args.syncCursor && !this.cursorsValid) {
      throw new ProviderError("cursor-expired", "stale cursor");
    }
    return {
      items: [...this.events.values()].filter(
        (e) => e.calendarId === args.calendarId,
      ),
      nextPageCursor: null,
      commitCursor: "cursor-1" as SyncCursor,
    };
  }

  async getEvent(ref: EventRef): Promise<ProviderEvent> {
    const event = this.events.get(ref.eventId);
    if (!event) throw new ProviderError("not-found", "no such event");
    return event;
  }

  async createEvent(request: CreateEventRequest): Promise<ProviderEvent> {
    if (this.opts.readOnlyCalendars?.has(request.calendarId)) {
      throw new ProviderError("permission", "read-only calendar");
    }
    if (this.opts.nextCreateThrowsWithoutLanding) {
      const kind = this.opts.nextCreateThrowsWithoutLanding;
      this.opts.nextCreateThrowsWithoutLanding = undefined;
      throw new ProviderError(kind, "lost, did not land");
    }
    const landed = this.land(request);
    if (this.opts.nextCreateThrows) {
      const kind = this.opts.nextCreateThrows;
      this.opts.nextCreateThrows = undefined;
      throw new ProviderError(kind, "landed but response lost");
    }
    return landed;
  }

  async reconcileAmbiguousCreate(args: {
    calendarId: string;
    idempotencyKey: string;
  }): Promise<ProviderEvent | null> {
    const id = this.byKey.get(args.idempotencyKey);
    return id ? (this.events.get(id) ?? null) : null;
  }

  async updateEvent(args: {
    ref: EventRef;
    patch: EventPatch;
    notify?: NotifyScope;
    idempotencyKey?: string;
    expectedUpdatedMs?: number;
  }): Promise<ProviderEvent> {
    const event = await this.getEvent(args.ref);
    const updated = {
      ...event,
      ...(args.patch.summary !== undefined ? { summary: args.patch.summary } : {}),
      ...(args.patch.description !== undefined
        ? { description: args.patch.description ?? undefined }
        : {}),
    };
    this.events.set(event.id, updated);
    return updated;
  }

  async respondToEvent(args: {
    ref: EventRef;
    responseStatus: "accepted" | "tentative" | "declined";
    notify?: NotifyScope;
    idempotencyKey?: string;
  }): Promise<ProviderEvent> {
    const event = await this.getEvent(args.ref);
    const updated: ProviderEvent = {
      ...event,
      attendees: event.attendees?.map((a) =>
        a.self ? { ...a, responseStatus: args.responseStatus } : a,
      ),
    };
    this.events.set(event.id, updated);
    return updated;
  }

  async deleteEvent(args: {
    ref: EventRef;
    mode: "cancel" | "remove-self";
    notify?: NotifyScope;
    idempotencyKey?: string;
  }): Promise<void> {
    this.events.delete(args.ref.eventId);
  }

  size() {
    return this.events.size;
  }
}

const write = (summary: string): EventCreate => ({
  summary,
  startMs: 1_000,
  endMs: 2_000,
  allDay: false,
});
const req = (calendarId: string, summary: string): CreateEventRequest => ({
  calendarId,
  event: write(summary),
});

describe("port conformance with a non-Google adapter", () => {
  test("CRUD round-trips with provider-neutral ids", async () => {
    const a = new FakeCalendarAdapter();
    const created = await a.createEvent(req("cal", "Standup"));
    expect(created.id.startsWith("fk-")).toBe(true); // not a Google id

    const ref = { calendarId: "cal", eventId: created.id };
    expect((await a.getEvent(ref)).summary).toBe("Standup");
    expect((await a.updateEvent({ ref, patch: { summary: "Retro" } })).summary).toBe(
      "Retro",
    );
    await a.deleteEvent({ ref, mode: "cancel", idempotencyKey: "delete-1" });
    await expect(a.getEvent(ref)).rejects.toThrow(ProviderError);
  });

  test("create values and explicit patch clearing remain distinct", async () => {
    const a = new FakeCalendarAdapter();
    const created = await a.createEvent({
      calendarId: "cal",
      event: { ...write("Notes"), description: "remove me" },
      idempotencyKey: "create-notes",
    });
    const updated = await a.updateEvent({
      ref: { calendarId: "cal", eventId: created.id },
      patch: { description: null },
      idempotencyKey: "clear-notes",
    });
    expect(updated.description).toBeUndefined();
  });

  test("RSVP updates only the self attendee", async () => {
    const a = new FakeCalendarAdapter();
    const created = await a.createEvent({
      calendarId: "cal",
      event: { ...write("Invite"), attendees: [{ email: "me@x.com" }] },
    });
    const answered = await a.respondToEvent({
      ref: { calendarId: "cal", eventId: created.id },
      responseStatus: "accepted",
    });
    expect(answered.attendees?.[0]?.responseStatus).toBe("accepted");
  });

  test("a recurring create returns master recurrence metadata", async () => {
    const a = new FakeCalendarAdapter();
    const created = await a.createEvent({
      calendarId: "cal",
      event: { ...write("Weekly"), recurrence: ["RRULE:FREQ=WEEKLY"] },
    });
    expect(created.recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
    expect(created.seriesId).toBeUndefined();
  });

  test("a stale cursor is a cursor-expired ProviderError", async () => {
    const a = new FakeCalendarAdapter();
    const page = await a.listEvents({
      calendarId: "cal",
      syncCursor: null,
      fromMs: 0,
      toMs: 9_999,
    });
    expect(page.commitCursor).toBe("cursor-1");
    a.expireCursors();
    await expect(
      a.listEvents({
        calendarId: "cal",
        syncCursor: page.commitCursor,
        fromMs: 0,
        toMs: 9_999,
      }),
    ).rejects.toMatchObject({ kind: "cursor-expired" });
  });

  test("a write to a read-only calendar is a permission ProviderError", async () => {
    const a = new FakeCalendarAdapter({ readOnlyCalendars: new Set(["holidays"]) });
    await expect(a.createEvent(req("holidays", "nope"))).rejects.toMatchObject({
      kind: "permission",
    });
  });

  test("an optional capability is declared, not assumed", () => {
    const capabilities = new FakeCalendarAdapter().capabilities;
    expect(capabilities.contacts).toBe(false);
    expect(capabilities.conference.create).toBe(false);
    expect(capabilities.attendeeMembershipUpdates).toBe(true);
    expect(capabilities.removeSelf).toBe(true);
  });
});

describe("createEventReconciling (neutral service, Interface Risk #1)", () => {
  test("an ambiguous create that actually landed reconciles to the same event, not a duplicate", async () => {
    const a = new FakeCalendarAdapter({ nextCreateThrows: "ambiguous" });
    const result = await createEventReconciling(a, {
      calendarId: "cal",
      event: write("Booking"),
      idempotencyKey: "op-1",
    });
    expect(result.id.startsWith("fk-")).toBe(true);
    // Reconciled from the key alone — no Google client-assigned id — and no
    // second event was created.
    expect(a.size()).toBe(1);
  });

  test("a conflict (already exists) reconciles to the existing event", async () => {
    const a = new FakeCalendarAdapter({ nextCreateThrows: "conflict" });
    const result = await createEventReconciling(a, {
      calendarId: "cal",
      event: write("Booking"),
      idempotencyKey: "op-2",
    });
    expect(result.id).toBe("fk-1");
    expect(a.size()).toBe(1);
  });

  test("an ambiguous create that never landed re-throws rather than inventing an event", async () => {
    const a = new FakeCalendarAdapter({ nextCreateThrowsWithoutLanding: "ambiguous" });
    await expect(
      createEventReconciling(a, {
        calendarId: "cal",
        event: write("Booking"),
        idempotencyKey: "op-3",
      }),
    ).rejects.toMatchObject({ kind: "ambiguous" });
    expect(a.size()).toBe(0);
  });

  test("without an idempotency key, an ambiguous create is not reconciled", async () => {
    const a = new FakeCalendarAdapter({ nextCreateThrows: "ambiguous" });
    await expect(
      createEventReconciling(a, { calendarId: "cal", event: write("Booking") }),
    ).rejects.toMatchObject({ kind: "ambiguous" });
  });
});
