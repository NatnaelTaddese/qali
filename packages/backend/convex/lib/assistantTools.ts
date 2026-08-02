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
  updateEventTimeOp,
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
        return { kind: "result", content: JSON.stringify(value) };
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
            timeZone: tc.timeZone,
          }),
          preview,
          nowMs: tc.nowMs,
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
    return formatWhen(startMs, timeZone, true);
  }
  const end = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(endMs));
  return `${formatWhen(startMs, timeZone)}–${end}`;
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
    "All times are Unix epoch milliseconds.",
  schema: listEventsSchema,
  async run(tc, args) {
    const rows = await tc.ctx.runQuery(api.calendar.listEventsInRange, {
      startMs: args.fromMs,
      endMs: args.toMs,
    });
    return rows.map((e) => ({
      eventId: e._id,
      summary: e.summary ?? "(No title)",
      startMs: e.startMs,
      endMs: e.endMs,
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

    const rows = await tc.ctx.runQuery(api.calendar.listEventsInRange, {
      startMs: args.fromMs,
      endMs: args.toMs,
    });
    const busy = mergeIntervals(
      rows.filter(isBusy).map((e) =>
        e.allDay
          ? allDayBusyInterval(e.startMs, e.endMs, tc.timeZone)
          : { startMs: e.startMs, endMs: e.endMs },
      ),
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
    "Look up a person's email address among the user's Google contacts by " +
    "name or partial email. Call this before adding a guest the user referred " +
    "to by first name only — never invent or guess an email address.",
  schema: z.object({
    query: z.string().min(1).describe("Name or partial email to match."),
  }),
  async run(tc, args) {
    const needle = args.query.trim().toLowerCase();
    const rows = await tc.ctx.runQuery(api.contacts.listContacts, {});
    return rows
      .filter(
        (c) =>
          c.displayName?.toLowerCase().includes(needle) ||
          c.emails.some((e) => e.toLowerCase().includes(needle)),
      )
      .slice(0, 10)
      .map((c) => ({ name: c.displayName, emails: c.emails }));
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

const createEventSchema = z.object({
  summary: z.string().min(1).describe("Event title."),
  startMs: z.number().describe("Start instant, epoch ms."),
  endMs: z.number().describe("End instant, epoch ms."),
  allDay: z.boolean().optional().describe("True for an all-day event."),
  description: z.string().optional(),
  location: z.string().optional(),
  guestEmails: z
    .array(z.string())
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
    .array(z.string())
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
    const guests = args.guestEmails?.length
      ? ` · invites ${args.guestEmails.join(", ")}`
      : "";
    return `Create “${args.summary}” ${formatRange(args.startMs, args.endMs, tc.timeZone, args.allDay)}${guests}`;
  },
});

const updateEventSchema = z.object({
  eventId: z.string().describe("The eventId from list_events."),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  startMs: z.number().optional().describe("Send with endMs, or not at all."),
  endMs: z.number().optional(),
  guestEmails: z
    .array(z.string())
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
    const row = await requireEditable(tc, args.eventId);
    const parts: string[] = [];
    if (args.summary) parts.push(`title → “${args.summary}”`);
    if (args.startMs !== undefined && args.endMs !== undefined) {
      parts.push(
        `time → ${formatRange(args.startMs, args.endMs, tc.timeZone, row.allDay)}`,
      );
    }
    if (args.location) parts.push(`location → ${args.location}`);
    if (args.description !== undefined) parts.push("description updated");
    if (args.guestEmails) {
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
});

const moveEventSchema = z.object({
  eventId: z.string().describe("The eventId from list_events."),
  startMs: z.number().describe("New start instant, epoch ms."),
  endMs: z.number().describe("New end instant, epoch ms."),
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
      `${formatRange(args.startMs, args.endMs, tc.timeZone, row.allDay)}`
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
  preview(_tc, args) {
    return args.decision === "accept"
      ? "Accept this booking request and add it to your calendar"
      : "Reject this booking request";
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
  accessToken: string,
  action: Doc<"assistantActions">,
): Promise<string> {
  const raw: unknown = JSON.parse(action.input);
  const timeZone =
    typeof raw === "object" && raw !== null && "timeZone" in raw
      ? String((raw as { timeZone: unknown }).timeZone)
      : undefined;

  switch (action.tool) {
    case "create_event": {
      const args = createEventSchema.parse(raw);
      const event = await createEventOp(ctx, userId, accessToken, {
        summary: args.summary,
        startMs: args.startMs,
        endMs: args.endMs,
        allDay: args.allDay,
        description: args.description,
        location: args.location,
        attendees: args.guestEmails?.map((email) => ({ email })),
        addConference: args.addConference,
        recurrence: args.recurrence,
        timeZone,
      });
      return `Created “${event.summary ?? args.summary}”.`;
    }
    case "update_event": {
      const args = updateEventSchema.parse(raw);
      await updateEventOp(ctx, userId, accessToken, {
        eventId: args.eventId as Id<"events">,
        summary: args.summary,
        description: args.description,
        location: args.location,
        startMs: args.startMs,
        endMs: args.endMs,
        attendees: args.guestEmails?.map((email) => ({ email })),
        scope: args.scope,
        timeZone,
      });
      return "Event updated.";
    }
    case "move_event": {
      const args = moveEventSchema.parse(raw);
      await updateEventTimeOp(ctx, userId, accessToken, {
        eventId: args.eventId as Id<"events">,
        startMs: args.startMs,
        endMs: args.endMs,
        timeZone,
      });
      return "Event rescheduled.";
    }
    case "delete_event": {
      const args = deleteEventSchema.parse(raw);
      await deleteEventOp(ctx, userId, accessToken, {
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
