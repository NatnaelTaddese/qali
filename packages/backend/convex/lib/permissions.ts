// What the signed-in user is allowed to do to one event.
//
// This module is deliberately a *leaf*: it imports nothing, so the web app can
// pull it in and reach the same verdict the backend enforces. Keep it that way
// — an import of `_generated/server` or `convex/values` here would drag the
// server runtime into the browser bundle.
//
// Google's own permission model is spread across several fields that disagree
// about their defaults, so read them only through this file.

/** Access roles that let us write to a calendar at all. Anything else — a
 * `reader`, a `freeBusyReader`, or a calendar we hold no row for — is
 * read-only, so an unknown role fails closed. */
const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer"]);

/** Event types Google generates and maintains itself. These sit on a calendar
 * you own, so the access role says "writer" while Google rejects every edit —
 * which is exactly why the access role alone is not enough to gate on. */
const GOOGLE_MANAGED_EVENT_TYPES = new Set([
  "birthday",
  "workingLocation",
  "fromGmail",
]);

/** The subset of an event this module reads. `Doc<"events">` satisfies it
 * structurally, so nothing here has to import the generated data model. */
export interface EventLike {
  attendees?: { self?: boolean; responseStatus?: string }[];
  organizer?: { self?: boolean };
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  locked?: boolean;
  eventType?: string;
  recurringEventId?: string;
}

export interface CalendarLike {
  accessRole?: string;
}

export interface EventCapabilities {
  /** Title, description, location, times, colour, all-day. */
  canEdit: boolean;
  canInviteOthers: boolean;
  canSeeGuests: boolean;
  /** Hard delete — cancels the event for every guest. */
  canDelete: boolean;
  /** Remove your own copy, leaving the organiser's untouched. */
  canRemoveSelf: boolean;
  canRespond: boolean;
  canChangeRecurrence: boolean;
  isOrganizer: boolean;
  /** Your own RSVP: "needsAction" | "declined" | "tentative" | "accepted". */
  selfResponse?: string;
  /** Why editing is off, phrased for the user. `undefined` means it isn't.
   * One string, shown by both the detail view's badge and the form. */
  readOnlyReason?: string;
}

export function eventCapabilities(
  event: EventLike,
  calendar: CalendarLike | undefined,
): EventCapabilities {
  const selfAttendee = event.attendees?.find((a) => a.self);
  const writableCalendar = WRITABLE_ACCESS_ROLES.has(calendar?.accessRole ?? "");
  const googleManaged = GOOGLE_MANAGED_EVENT_TYPES.has(event.eventType ?? "");

  // A row synced before we stored any of these fields can't be judged on its
  // own merits, and turning every such event read-only the moment this ships
  // would be worse than the imprecision it replaces. Fall back to the calendar's
  // access role — the rule the app enforced before. A full resync retires this.
  const unknownProvenance =
    event.organizer === undefined && event.attendees === undefined;
  const isOrganizer =
    event.organizer?.self === true || (unknownProvenance && writableCalendar);

  // First matching rule wins: the reason we show should name the most
  // fundamental obstacle, not the last one checked.
  const readOnlyReason = googleManaged
    ? "Google manages this event"
    : !writableCalendar
      ? "You have read-only access to this calendar"
      : event.locked
        ? "The organiser locked this event"
        : !isOrganizer && event.guestsCanModify !== true
          ? "Only the organiser can edit this event"
          : undefined;

  const canEdit = readOnlyReason === undefined;

  return {
    canEdit,
    // An absent flag means Google's default, and the defaults disagree:
    // guestsCanModify defaults to false (handled above), while these two
    // default to true. Never compare them to `true` directly.
    canInviteOthers:
      canEdit && (isOrganizer || (event.guestsCanInviteOthers ?? true)),
    canSeeGuests:
      !googleManaged && (isOrganizer || (event.guestsCanSeeOtherGuests ?? true)),
    canDelete: writableCalendar && !googleManaged && isOrganizer,
    canRemoveSelf:
      writableCalendar &&
      !googleManaged &&
      !isOrganizer &&
      selfAttendee !== undefined,
    // Independent of canEdit: answering an invitation is not editing it, and
    // still works on an event locked against every other change. It does need
    // write access to the calendar holding the copy we would patch.
    canRespond: writableCalendar && selfAttendee !== undefined,
    // We sync with singleEvents=true, so a recurring row is one expanded
    // instance and never carries its own rule — there is nothing here to edit.
    canChangeRecurrence: canEdit && event.recurringEventId === undefined,
    isOrganizer,
    selfResponse: selfAttendee?.responseStatus,
    readOnlyReason,
  };
}
