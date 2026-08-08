/**
 * Everything the assistant can do, declared once.
 *
 * Each tool carries its zod argument schema, the JSON Schema the model is shown
 * (derived from that same zod schema, so the two cannot drift), and a handler.
 *
 * The split that matters is `kind`:
 *   - `"read"` tools run immediately inside the agent loop.
 *   - `"write"` tools never touch Google. They record a row in
 *     `assistantActions` and hand the model back a result that says, in as many
 *     words, that nothing has happened yet. Only a confirm click reaches
 *     `applyProposal` below, and only that calls into `calendarOps`.
 *
 * So a misread date costs the user a glance at a card, not an invitation email
 * to their whole guest list.
 */

import { z } from "zod";

import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  createEventOp,
  deleteEventOp,
  resolveEventForWrite,
  updateEventOp,
} from "./calendarOps";
import {
  MS_PER_MINUTE,
  addDaysToDateKey,
  type Interval,
  mergeIntervals,
  allDayBusyInterval,
  utcToZoned,
  zonedToUtcMs,
} from "./availability";
import { subtractBusy } from "./assistantHistory";
import {
  assistantRangeToEventTime,
  formatAssistantAllDayRange,
  isDateKey,
  type AssistantEventRange,
} from "./assistantLogic";

// --- Plumbing --------------------------------------------------------------

export interface ToolContext {
  ctx: ActionCtx;
  userId: string;
  threadId: Id<"assistantThreads">;
  /** The browser's IANA zone for this turn. Never inferred from the runtime. */
  timeZone: string;
  nowMs: number;
}

/** What a tool hands back to the loop. A `proposal` also produces a confirm
 * card, which is why it carries the row id alongside the model-facing text. */
export type ToolOutcome =
  | { kind: "result"; content: string; isError?: boolean }
  | { kind: "proposal"; content: string; actionId: Id<"assistantActions"> };

export interface AssistantTool {
  name: string;
  kind: "read" | "write";
  description: string;
  parameters: Record<string, unknown>;
  run(
    tc: ToolContext,
    toolCallId: string,
    rawArgs: unknown,
  ): Promise<ToolOutcome>;
}

const MAX_TOOL_RESULT_CHARS = 8_000;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  // The $schema key is noise in a function definition and only costs prefix
  // tokens on every request.
  delete generated.$schema;
  return generated;
}

/** Build a read tool: validate, run, serialize. Anything thrown becomes an
 * error result the model can read and explain rather than a dead turn. */
function readTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  schema: S;
  run(tc: ToolContext, args: z.infer<S>): Promise<unknown>;
}): AssistantTool {
  return {
    name: spec.name,
    kind: "read",
    description: spec.description,
    parameters: jsonSchema(spec.schema),
    async run(tc, _toolCallId, rawArgs) {
      const parsed = spec.schema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "result",
          content: `Invalid arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      try {
        const value = await spec.run(tc, parsed.data);
        const content = JSON.stringify(value);
        if (content.length > MAX_TOOL_RESULT_CHARS) {
          return {
            kind: "result",
            content: "That lookup returned too much data. Use a smaller range or a more specific query.",
            isError: true,
          };
        }
        return { kind: "result", content };
      } catch (error) {
        return {
          kind: "result",
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

/**
 * Build a write tool.
 *
 * `preview` does double duty: it produces the sentence the confirm card shows,
 * and it is where the tool refuses work the user could not do by hand either —
 * a locked event, a birthday Google generates, a calendar they only have read
 * access to. It throws for those, and the reason reaches the model as the tool
 * result, so the user is told why instead of being handed a confirm button that
 * fails when they press it. No proposal row is written when it throws.
 */
function writeTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  schema: S;
  preview(tc: ToolContext, args: z.infer<S>): Promise<string> | string;
  storedArgs?(
    tc: ToolContext,
    args: z.infer<S>,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}): AssistantTool {
  return {
    name: spec.name,
    kind: "write",
    description: spec.description,
    parameters: jsonSchema(spec.schema),
    async run(tc, toolCallId, rawArgs) {
      const parsed = spec.schema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "result",
          content: `Invalid arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      let preview: string;
      try {
        preview = await spec.preview(tc, parsed.data);
      } catch (error) {
        return {
          kind: "result",
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }

      const actionId = await tc.ctx.runMutation(
        internal.assistantData.recordProposal,
        {
          threadId: tc.threadId,
          userId: tc.userId,
          toolCallId,
          tool: spec.name,
          // The turn's zone rides along with the arguments: the proposal may be
          // confirmed hours later, from a context that no longer knows it.
          input: JSON.stringify({
            ...(parsed.data as object),
            ...(spec.storedArgs ? await spec.storedArgs(tc, parsed.data) : {}),
            timeZone: tc.timeZone,
          }),
          preview,
        },
      );

      return {
        kind: "proposal",
        actionId,
        content:
          `Proposed: ${preview}. This has NOT happened yet — it is waiting for the ` +
          `user to confirm it on a card in the app. Tell them what you proposed and ` +
          `ask them to confirm; do not claim it is done, and do not propose it again.`,
      };
    },
  };
}

// --- Formatting ------------------------------------------------------------

/** How an instant reads to the user, for previews the model and the confirm
 * card both show. Always rendered in the turn's zone, never the server's. */
function formatWhen(ms: number, timeZone: string, allDay = false): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(allDay ? {} : { hour: "numeric", minute: "2-digit" }),
  }).format(new Date(ms));
}

function formatRange(
  startMs: number,
  endMs: number,
  timeZone: string,
  allDay = false,
): string {
  if (allDay) {
    return formatAssistantAllDayRange(
      new Date(startMs).toISOString().slice(0, 10),
      new Date(endMs).toISOString().slice(0, 10),
    );
  }
  const end = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(endMs));
  return `${formatWhen(startMs, timeZone)}–${end}`;
}

function formatAssistantRange(
  range: AssistantEventRange,
  timeZone: string,
): string {
  if (range.kind === "allDay") {
    return formatAssistantAllDayRange(range.startDate, range.endDate);
  }
  return formatRange(range.startMs, range.endMs, timeZone);
}

function previewValue(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// --- Free-time search ------------------------------------------------------

/** Whether an event blocks the user's time. A "free"-marked event doesn't, a
 * cancelled one doesn't, and neither does one they've declined — that last
 * case is the difference between an honest answer and offering a slot the user
 * already said no to. */
function isBusy(event: Doc<"events">): boolean {
  if (event.status === "cancelled") return false;
  if (event.transparency === "transparent") return false;
  const self = event.attendees?.find((a) => a.self);
  if (self?.responseStatus === "declined") return false;
  return true;
}

// --- The tools -------------------------------------------------------------

const listEventsSchema = z.object({
  fromMs: z.number().describe("Start of the range, Unix epoch milliseconds."),
  toMs: z.number().describe("End of the range, Unix epoch milliseconds."),
});

const listEvents = readTool({
  name: "list_events",
  description:
    "List the events on the user's calendar that overlap a time range. Call " +
    "this whenever the user asks what is on their calendar, whether they are " +
    "free, or refers to an existing meeting you have not already looked up — " +
    "you need the eventId from here before you can change or cancel anything. " +
    "Timed values are Unix epoch milliseconds; all-day results also include " +
    "literal startDate and exclusive endDate values.",
  schema: listEventsSchema,
  async run(tc, args) {
    // Personal events plus shared public-calendar events (holidays/birthdays),
    // which live in a separate deduplicated table. Merged so the assistant sees
    // holidays alongside the user's own events.
    const [personal, shared] = await Promise.all([
      tc.ctx.runQuery(internal.assistantData.listEventsForAssistant, {
        userId: tc.userId,
        startMs: args.fromMs,
        endMs: args.toMs,
      }),
      tc.ctx.runQuery(internal.calendar.listSharedEventsForAssistant, {
        userId: tc.userId,
        startMs: args.fromMs,
        endMs: args.toMs,
      }),
    ]);
    const rows = [...personal, ...shared].sort((a, b) => a.startMs - b.startMs);
    return rows.map((e) => ({
      eventId: e._id,
      summary: e.summary ?? "(No title)",
      startMs: e.startMs,
      endMs: e.endMs,
      ...(e.allDay
        ? {
            startDate: new Date(e.startMs).toISOString().slice(0, 10),
            endDate: new Date(e.endMs).toISOString().slice(0, 10),
          }
        : {}),
      when: formatRange(e.startMs, e.endMs, tc.timeZone, e.allDay),
      allDay: e.allDay,
      location: e.location,
      recurring: Boolean(e.recurringEventId),
      isOrganizer: e.organizer?.self ?? false,
      guests: e.attendees?.map((a) => a.email) ?? [],
      meetLink: e.hangoutLink,
    }));
  },
});

const findFreeTimeSchema = z.object({
  fromMs: z.number().describe("Earliest instant to consider, epoch ms."),
  toMs: z.number().describe("Latest instant to consider, epoch ms."),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .describe("How long the meeting needs to be."),
  dayStartHour: z
    .number()
    .int()
    .min(0)
    .max(23)
    .optional()
    .describe("Earliest hour of the day to offer, local time. Defaults to 9."),
  dayEndHour: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe("Latest hour of the day to offer, local time. Defaults to 18."),
});

const findFreeTime = readTool({
  name: "find_free_time",
  description:
    "Find gaps of at least a given length on the user's calendar, restricted " +
    "to daytime hours in their own time zone. Call this whenever the user asks " +
    "when they are free, or asks you to schedule something without naming an " +
    "exact time — do not guess at availability from list_events yourself.",
  schema: findFreeTimeSchema,
  async run(tc, args) {
    const dayStartMin = (args.dayStartHour ?? 9) * 60;
    const dayEndMin = (args.dayEndHour ?? 18) * 60;
    if (dayEndMin <= dayStartMin) {
      throw new Error("dayEndHour must be later than dayStartHour");
    }
    const durationMs = args.durationMinutes * MS_PER_MINUTE;

    const [personal, shared, bookings] = await Promise.all([
      tc.ctx.runQuery(internal.assistantData.listEventsForAssistant, {
        userId: tc.userId,
        startMs: args.fromMs,
        endMs: args.toMs,
      }),
      tc.ctx.runQuery(internal.calendar.listSharedEventsForAssistant, {
        userId: tc.userId,
        startMs: args.fromMs,
        endMs: args.toMs,
      }),
      tc.ctx.runQuery(internal.assistantData.listBookingBlocksForAssistant, {
        userId: tc.userId,
        startMs: args.fromMs,
        endMs: args.toMs,
      }),
    ]);
    // Holidays are transparency:"transparent", so isBusy drops them and they
    // never block a slot — but a holiday marked busy correctly would.
    const rows = [...personal, ...shared];
    const busy = mergeIntervals(
      [
        ...rows.filter(isBusy).map((e) =>
          e.allDay
            ? allDayBusyInterval(e.startMs, e.endMs, tc.timeZone)
            : { startMs: e.startMs, endMs: e.endMs },
        ),
        ...bookings
          .filter(
            (booking) =>
              booking.startMs < args.toMs && booking.endMs > args.fromMs,
          )
          .map((booking) => ({
            startMs: booking.startMs,
            endMs: booking.endMs,
          })),
      ],
    );

    // Walk calendar days rather than fixed 24h blocks, so a DST change doesn't
    // slide the working-hours window by an hour partway through the range.
    const windows: Interval[] = [];
    const lastKey = utcToZoned(args.toMs, tc.timeZone).dateKey;
    let key = utcToZoned(args.fromMs, tc.timeZone).dateKey;
    for (let i = 0; i < 400 && key <= lastKey; i += 1) {
      const startMs = Math.max(
        zonedToUtcMs(key, dayStartMin, tc.timeZone),
        args.fromMs,
        // Never offer a slot in the past.
        tc.nowMs,
      );
      const endMs = Math.min(
        zonedToUtcMs(key, dayEndMin, tc.timeZone),
        args.toMs,
      );
      if (endMs - startMs >= durationMs) {
        windows.push({ startMs, endMs });
      }
      key = addDaysToDateKey(key, 1);
    }

    const free = windows
      .flatMap((w) => subtractBusy(w, busy))
      .filter((gap) => gap.endMs - gap.startMs >= durationMs)
      .slice(0, 25);

    return {
      durationMinutes: args.durationMinutes,
      timeZone: tc.timeZone,
      openings: free.map((gap) => ({
        startMs: gap.startMs,
        // The latest this meeting could start and still fit in the gap.
        latestStartMs: gap.endMs - durationMs,
        when: formatRange(gap.startMs, gap.endMs, tc.timeZone),
      })),
    };
  },
});

const searchContacts = readTool({
  name: "search_contacts",
  description:
    "Look up a person's email address among the people the user knows — saved " +
    "Google contacts plus anyone they've met on their calendar — by name or " +
    "partial email. Call this before adding a guest the user referred to by " +
    "first name only — never invent or guess an email address.",
  schema: z.object({
    query: z.string().min(1).describe("Name or partial email to match."),
  }),
  async run(tc, args) {
    const needle = args.query.trim().toLowerCase();
    const rows = await tc.ctx.runQuery(api.people.listPeople, {});
    return rows
      .filter(
        (p) =>
          p.displayName?.toLowerCase().includes(needle) ||
          p.email.toLowerCase().includes(needle),
      )
      .slice(0, 10)
      .map((p) => ({ name: p.displayName, email: p.email }));
  },
});

const getAvailabilitySettings = readTool({
  name: "get_availability_settings",
  description:
    "Read the user's public booking-page configuration: their slug, meeting " +
    "length, buffer, notice period, and weekly opening hours. Call this when " +
    "the user asks about their booking link or the hours they publish.",
  schema: z.object({}),
  async run(tc) {
    return await tc.ctx.runQuery(api.booking.getMyBookingPage, {});
  },
});

const listPendingBookings = readTool({
  name: "list_pending_booking_requests",
  description:
    "List appointment requests other people have submitted through the user's " +
    "public booking page and that are still awaiting a decision. Call this " +
    "when the user asks who wants to meet or what needs their reply.",
  schema: z.object({}),
  async run(tc) {
    const rows = await tc.ctx.runQuery(api.booking.listPendingBookings, {});
    return rows.map((b) => ({
      bookingId: b._id,
      requesterName: b.requesterName,
      requesterEmail: b.requesterEmail,
      startMs: b.startMs,
      when: formatRange(b.startMs, b.endMs, tc.timeZone),
      note: b.note,
    }));
  },
});

const timedRangeSchema = z
  .object({
    kind: z.literal("timed"),
    startMs: z.number().finite().describe("Start instant, epoch ms."),
    endMs: z.number().finite().describe("End instant, epoch ms."),
  })
  .refine((range) => range.endMs > range.startMs, {
    message: "endMs must be later than startMs",
  });

const dateKeySchema = z
  .string()
  .refine(isDateKey, "Use a real calendar date in YYYY-MM-DD form");

const allDayRangeSchema = z
  .object({
    kind: z.literal("allDay"),
    startDate: dateKeySchema.describe("First calendar date, YYYY-MM-DD."),
    endDate: dateKeySchema.describe(
      "Exclusive end date, YYYY-MM-DD. For one day, use the following date.",
    ),
  })
  .refine((range) => range.endDate > range.startDate, {
    message: "endDate must be later than startDate",
  });

const eventRangeSchema = z.union([timedRangeSchema, allDayRangeSchema]);

const createEventSchema = z.object({
  summary: z.string().min(1).max(500).describe("Event title."),
  time: eventRangeSchema.describe(
    "Timed events use epoch milliseconds. All-day events use calendar dates and an exclusive end date; never convert those dates through a timezone.",
  ),
  description: z.string().max(4_000).optional(),
  location: z.string().max(1_000).optional(),
  guestEmails: z
    .array(z.string().email().max(320))
    .max(200)
    .optional()
    .describe(
      "Email addresses to invite. Google emails each one an invitation the " +
        "moment the user confirms, so only include addresses you have " +
        "confirmed via search_contacts or that the user typed themselves.",
    ),
  addConference: z
    .boolean()
    .optional()
    .describe("Attach a Google Meet link."),
  recurrence: z
    .array(z.string().max(500))
    .max(10)
    .optional()
    .describe('RFC5545 lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"].'),
});

const createEvent = writeTool({
  name: "create_event",
  description:
    "Propose creating a new event on the user's primary calendar. Use this " +
    "for any request to schedule, book, or block out time. The event is not " +
    "created and no invitations are sent until the user confirms.",
  schema: createEventSchema,
  preview(tc, args) {
    const parts = [`at ${formatAssistantRange(args.time, tc.timeZone)}`];
    if (args.description !== undefined) {
      parts.push(`description “${previewValue(args.description)}”`);
    }
    if (args.location !== undefined) {
      parts.push(`location “${previewValue(args.location)}”`);
    }
    if (args.guestEmails !== undefined) {
      parts.push(
        args.guestEmails.length
          ? `invite ${args.guestEmails.join(", ")}`
          : "no guests",
      );
    }
    if (args.addConference !== undefined) {
      parts.push(args.addConference ? "add Google Meet" : "no conference");
    }
    if (args.recurrence !== undefined) {
      parts.push(
        args.recurrence.length
          ? `recurrence ${args.recurrence.join("; ")}`
          : "non-recurring",
      );
    }
    return `Create “${args.summary}”: ${parts.join(" · ")}`;
  },
});

const updateEventSchema = z.object({
  eventId: z.string().describe("The eventId from list_events."),
  summary: z.string().min(1).max(500).optional(),
  description: z.string().max(4_000).optional(),
  location: z.string().max(1_000).optional(),
  time: eventRangeSchema.optional().describe(
    "Replacement time. Use date-only startDate/endDate for all-day events.",
  ),
  guestEmails: z
    .array(z.string().email().max(320))
    .max(200)
    .optional()
    .describe("Replaces the guest list wholesale — anyone omitted is uninvited."),
  scope: z
    .enum(["thisEvent", "thisAndFollowing", "allEvents"])
    .optional()
    .describe(
      "For a recurring event, how far the change reaches. Ask the user which " +
        "they mean rather than assuming. Defaults to this occurrence only.",
    ),
});

/** Refuse an edit the user could not make by hand either. `resolveEventForWrite`
 * throws with the reason, which becomes the model's tool result. */
async function requireEditable(tc: ToolContext, eventId: string): Promise<Doc<"events">> {
  const { row } = await resolveEventForWrite(
    tc.ctx,
    tc.userId,
    eventId as Id<"events">,
    ["canEdit"],
  );
  return row;
}

const updateEvent = writeTool({
  name: "update_event",
  description:
    "Propose changing an existing event's title, description, location, guest " +
    "list, or times. Requires an eventId from list_events. Nothing changes and " +
    "no guest is notified until the user confirms.",
  schema: updateEventSchema,
  async preview(tc, args) {
    const { row, capabilities } = await resolveEventForWrite(
      tc.ctx,
      tc.userId,
      args.eventId as Id<"events">,
      ["canEdit"],
    );
    if (args.guestEmails !== undefined && !capabilities.canInviteOthers) {
      throw new Error("The organiser does not allow you to invite or remove guests");
    }
    const parts: string[] = [];
    if (args.summary !== undefined) parts.push(`title → “${args.summary}”`);
    if (args.time !== undefined) {
      parts.push(`time → ${formatAssistantRange(args.time, tc.timeZone)}`);
    }
    if (args.location !== undefined) {
      parts.push(`location → “${previewValue(args.location)}”`);
    }
    if (args.description !== undefined) {
      parts.push(`description → “${previewValue(args.description)}”`);
    }
    if (args.guestEmails !== undefined) {
      parts.push(
        args.guestEmails.length
          ? `guests → ${args.guestEmails.join(", ")}`
          : "all guests removed",
      );
    }
    const scope =
      row.recurringEventId && args.scope && args.scope !== "thisEvent"
        ? args.scope === "allEvents"
          ? " (whole series)"
          : " (this and following)"
        : "";
    return `Update “${row.summary ?? "(No title)"}”${scope}: ${parts.join(", ") || "no changes"}`;
  },
  async storedArgs(tc, args) {
    if (args.guestEmails === undefined) return {};
    const row = await requireEditable(tc, args.eventId);
    const editsSeries =
      row.recurringEventId !== undefined &&
      args.scope !== undefined &&
      args.scope !== "thisEvent";
    const expectedSeriesUpdatedMs = editsSeries
      ? await tc.ctx.runQuery(
          internal.assistantData.getRecurringSeriesVersion,
          { userId: tc.userId, eventId: row._id },
        )
      : null;
    if (editsSeries && expectedSeriesUpdatedMs === null) {
      throw new Error(
        "The recurring series is not fully synced yet. Refresh it before changing guests.",
      );
    }
    return {
      expectedGoogleUpdatedMs: row.googleUpdatedMs,
      ...(expectedSeriesUpdatedMs === null ? {} : { expectedSeriesUpdatedMs }),
    };
  },
});

const moveEventSchema = z.object({
  eventId: z.string().describe("The eventId from list_events."),
  time: eventRangeSchema.describe(
    "New time. For an all-day event use startDate and exclusive endDate, not epoch milliseconds.",
  ),
});

const moveEvent = writeTool({
  name: "move_event",
  description:
    "Propose rescheduling one event, keeping everything else about it the " +
    "same. Prefer this over update_event when only the time changes. The event " +
    "does not move until the user confirms.",
  schema: moveEventSchema,
  async preview(tc, args) {
    const row = await requireEditable(tc, args.eventId);
    return (
      `Move “${row.summary ?? "(No title)"}” from ` +
      `${formatRange(row.startMs, row.endMs, tc.timeZone, row.allDay)} to ` +
      `${formatAssistantRange(args.time, tc.timeZone)}`
    );
  },
});

const deleteEventSchema = z.object({
  eventId: z.string().describe("The eventId from list_events."),
});

const deleteEvent = writeTool({
  name: "delete_event",
  description:
    "Propose deleting an event. If the user organises it this cancels it for " +
    "every guest and emails them; if they are only a guest it just removes " +
    "their own copy. Nothing is deleted until the user confirms.",
  schema: deleteEventSchema,
  async preview(tc, args) {
    const { row, capabilities } = await resolveEventForWrite(
      tc.ctx,
      tc.userId,
      args.eventId as Id<"events">,
      ["canDelete", "canRemoveSelf"],
    );
    const guests = row.attendees?.length ?? 0;
    const verb =
      capabilities.isOrganizer && guests > 0
        ? `Cancel “${row.summary ?? "(No title)"}” and notify ${guests} guest${guests === 1 ? "" : "s"}`
        : `Remove “${row.summary ?? "(No title)"}” from your calendar`;
    return `${verb} · ${formatRange(row.startMs, row.endMs, tc.timeZone, row.allDay)}`;
  },
});

const decideBookingSchema = z.object({
  bookingId: z
    .string()
    .describe("The bookingId from list_pending_booking_requests."),
  decision: z.enum(["accept", "reject"]),
});

const decideBookingRequest = writeTool({
  name: "decide_booking_request",
  description:
    "Propose accepting or rejecting an appointment request from the user's " +
    "public booking page. Accepting creates the event and emails the " +
    "requester. Neither happens until the user confirms.",
  schema: decideBookingSchema,
  async preview(tc, args) {
    const context = await tc.ctx.runQuery(internal.booking.getBookingContext, {
      bookingId: args.bookingId as Id<"bookings">,
      hostUserId: tc.userId,
    });
    if (!context || context.booking.status !== "pending") {
      throw new Error("Booking request not found or already answered");
    }
    const { booking, page } = context;
    const who = `${booking.requesterName} <${booking.requesterEmail}>`;
    const when = formatRange(booking.startMs, booking.endMs, tc.timeZone);
    if (args.decision === "reject") {
      return `Reject ${who}'s booking request for ${when}`;
    }
    const label = page.title?.trim() || "Meeting";
    const note = booking.note ? ` · include note “${previewValue(booking.note)}”` : "";
    return `Accept ${who} for ${when} · create “${label} with ${booking.requesterName}” · invite ${booking.requesterEmail}${note}`;
  },
});

/** Registration order is the order these serialize into the request prefix, so
 * it is deliberately fixed: reordering the array would invalidate DeepSeek's
 * automatic context cache for every existing conversation. */
export const ASSISTANT_TOOLS: AssistantTool[] = [
  listEvents,
  findFreeTime,
  searchContacts,
  getAvailabilitySettings,
  listPendingBookings,
  createEvent,
  updateEvent,
  moveEvent,
  deleteEvent,
  decideBookingRequest,
];

export const TOOLS_BY_NAME = new Map(ASSISTANT_TOOLS.map((t) => [t.name, t]));

// --- Applying a confirmed proposal -----------------------------------------

/**
 * Carry out a proposal the user confirmed.
 *
 * The stored arguments are parsed against the same zod schema the model was
 * held to, not trusted because they are already in the database — the row has
 * been sitting where a schema change or a bad write could have reached it.
 */
export async function applyProposal(
  ctx: ActionCtx,
  userId: string,
  accessToken: string | undefined,
  action: Doc<"assistantActions">,
): Promise<string> {
  const stored: unknown = JSON.parse(action.input);
  const raw = await normalizeStoredProposal(
    ctx,
    userId,
    action.tool,
    stored,
  );
  const timeZone =
    typeof raw === "object" && raw !== null && "timeZone" in raw
      ? String((raw as { timeZone: unknown }).timeZone)
      : undefined;
  const operationId = action.operationId ?? String(action._id);
  const token = () => {
    if (!accessToken) throw new Error("Google access token is required");
    return accessToken;
  };

  switch (action.tool) {
    case "create_event": {
      const args = createEventSchema.parse(raw);
      const time = assistantRangeToEventTime(args.time);
      const event = await createEventOp(ctx, userId, token(), {
        summary: args.summary,
        ...time,
        description: args.description,
        location: args.location,
        attendees: args.guestEmails?.map((email) => ({ email })),
        addConference: args.addConference,
        recurrence: args.recurrence,
        timeZone,
        operationId,
      });
      return `Created “${event.summary ?? args.summary}”.`;
    }
    case "update_event": {
      const args = updateEventSchema.parse(raw);
      const time = args.time ? assistantRangeToEventTime(args.time) : undefined;
      const expectedGoogleUpdatedMs =
        typeof raw === "object" &&
        raw !== null &&
        "expectedGoogleUpdatedMs" in raw &&
        typeof raw.expectedGoogleUpdatedMs === "number"
          ? raw.expectedGoogleUpdatedMs
          : undefined;
      const expectedSeriesUpdatedMs =
        typeof raw === "object" &&
        raw !== null &&
        "expectedSeriesUpdatedMs" in raw &&
        typeof raw.expectedSeriesUpdatedMs === "number"
          ? raw.expectedSeriesUpdatedMs
          : undefined;
      await updateEventOp(ctx, userId, token(), {
        eventId: args.eventId as Id<"events">,
        summary: args.summary,
        description: args.description,
        location: args.location,
        startMs: time?.startMs,
        endMs: time?.endMs,
        allDay: time?.allDay,
        attendees: args.guestEmails?.map((email) => ({ email })),
        scope: args.scope,
        timeZone,
        operationId,
        expectedGoogleUpdatedMs,
        expectedSeriesUpdatedMs,
      });
      return "Event updated.";
    }
    case "move_event": {
      const args = moveEventSchema.parse(raw);
      const time = assistantRangeToEventTime(args.time);
      await updateEventOp(ctx, userId, token(), {
        eventId: args.eventId as Id<"events">,
        ...time,
        timeZone,
        operationId,
      });
      return "Event rescheduled.";
    }
    case "delete_event": {
      const args = deleteEventSchema.parse(raw);
      await deleteEventOp(ctx, userId, token(), {
        eventId: args.eventId as Id<"events">,
      });
      return "Event deleted.";
    }
    case "decide_booking_request": {
      const args = decideBookingSchema.parse(raw);
      const bookingId = args.bookingId as Id<"bookings">;
      if (args.decision === "accept") {
        await ctx.runAction(api.booking.acceptBooking, { bookingId });
        return "Booking request accepted.";
      }
      await ctx.runMutation(api.booking.rejectBooking, { bookingId });
      return "Booking request rejected.";
    }
    default:
      throw new Error(`Unknown proposal type: ${action.tool}`);
  }
}

/** Pending proposals created before the date-only contract may still be on
 * screen. Normalize only those persisted shapes at apply time; newly generated
 * tool schemas expose the unambiguous `time` union exclusively. */
async function normalizeStoredProposal(
  ctx: ActionCtx,
  userId: string,
  tool: string,
  raw: unknown,
): Promise<unknown> {
  if (
    typeof raw !== "object" ||
    raw === null ||
    "time" in raw ||
    !("startMs" in raw) ||
    !("endMs" in raw) ||
    typeof raw.startMs !== "number" ||
    typeof raw.endMs !== "number"
  ) {
    return raw;
  }

  let allDay =
    tool === "create_event" && "allDay" in raw && raw.allDay === true;
  if (
    (tool === "update_event" || tool === "move_event") &&
    "eventId" in raw &&
    typeof raw.eventId === "string"
  ) {
    const context = await ctx.runQuery(internal.calendar.getEventContext, {
      eventId: raw.eventId as Id<"events">,
      userId,
    });
    allDay = context?.event.allDay ?? false;
  }

  return {
    ...raw,
    time: allDay
      ? {
          kind: "allDay",
          startDate: new Date(raw.startMs).toISOString().slice(0, 10),
          endDate: new Date(raw.endMs).toISOString().slice(0, 10),
        }
      : { kind: "timed", startMs: raw.startMs, endMs: raw.endMs },
  };
}
