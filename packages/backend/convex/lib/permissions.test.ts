// @ts-expect-error Bun supplies its test module at runtime; the Convex
// TypeScript project intentionally does not include Bun's ambient types.
import { describe, expect, test } from "bun:test";

import { eventCapabilities, type EventLike } from "./permissions";

const OWNED = { accessRole: "owner" };
const SHARED_READ_ONLY = { accessRole: "reader" };

/** An event you organised on your own calendar. */
const mine: EventLike = { organizer: { self: true } };

describe("eventCapabilities", () => {
  test("an event you organise is fully yours", () => {
    const caps = eventCapabilities(mine, OWNED);

    expect(caps.canEdit).toBe(true);
    expect(caps.isOrganizer).toBe(true);
    expect(caps.canDelete).toBe(true);
    expect(caps.canInviteOthers).toBe(true);
    expect(caps.readOnlyReason).toBeUndefined();
    // No attendee marked `self`, so there is no invitation to answer.
    expect(caps.canRespond).toBe(false);
    expect(caps.canRemoveSelf).toBe(false);
  });

  test("a read-only calendar blocks everything", () => {
    const caps = eventCapabilities(mine, SHARED_READ_ONLY);

    expect(caps.canEdit).toBe(false);
    expect(caps.canDelete).toBe(false);
    expect(caps.readOnlyReason).toBe("You have read-only access to this calendar");
  });

  test("an unsynced calendar fails closed", () => {
    expect(eventCapabilities(mine, undefined).canEdit).toBe(false);
  });

  test("a birthday on your own calendar is still not editable", () => {
    // The case access-role gating alone gets wrong: owner access, but Google
    // generates and owns the event.
    const caps = eventCapabilities(
      { ...mine, eventType: "birthday" },
      OWNED,
    );

    expect(caps.canEdit).toBe(false);
    expect(caps.canDelete).toBe(false);
    expect(caps.canSeeGuests).toBe(false);
    expect(caps.readOnlyReason).toBe("Google manages this event");
  });

  test("a guest cannot edit unless guestsCanModify says so", () => {
    const invited: EventLike = {
      organizer: { self: false },
      attendees: [{ self: true, responseStatus: "needsAction" }],
    };

    const caps = eventCapabilities(invited, OWNED);
    expect(caps.canEdit).toBe(false);
    expect(caps.readOnlyReason).toBe("Only the organiser can edit this event");
    // The two things a guest *can* do.
    expect(caps.canRespond).toBe(true);
    expect(caps.selfResponse).toBe("needsAction");
    expect(caps.canRemoveSelf).toBe(true);
    expect(caps.canDelete).toBe(false);

    expect(
      eventCapabilities({ ...invited, guestsCanModify: true }, OWNED).canEdit,
    ).toBe(true);
  });

  test("guest flags apply Google's per-field defaults when absent", () => {
    const invited: EventLike = {
      organizer: { self: false },
      guestsCanModify: true,
      attendees: [{ self: true }],
    };

    // Absent means true for these two...
    const permissive = eventCapabilities(invited, OWNED);
    expect(permissive.canInviteOthers).toBe(true);
    expect(permissive.canSeeGuests).toBe(true);

    // ...and an explicit false must be honoured.
    const restricted = eventCapabilities(
      { ...invited, guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false },
      OWNED,
    );
    expect(restricted.canInviteOthers).toBe(false);
    expect(restricted.canSeeGuests).toBe(false);
    // Still editable — those flags don't govern the event's own fields.
    expect(restricted.canEdit).toBe(true);
  });

  test("a locked event can still be answered", () => {
    const caps = eventCapabilities(
      { ...mine, locked: true, attendees: [{ self: true }] },
      OWNED,
    );

    expect(caps.canEdit).toBe(false);
    expect(caps.readOnlyReason).toBe("The organiser locked this event");
    expect(caps.canRespond).toBe(true);
  });

  test("a recurring instance carries no rule to change", () => {
    expect(
      eventCapabilities({ ...mine, recurringEventId: "series-1" }, OWNED)
        .canChangeRecurrence,
    ).toBe(false);
    expect(eventCapabilities(mine, OWNED).canChangeRecurrence).toBe(true);
  });

  test("a row predating the sync keeps the old behaviour", () => {
    // No organizer and no attendees: synced before we stored either. Judge it
    // by the calendar, exactly as the app did before, rather than locking the
    // user out of their whole history until a resync finishes.
    const legacy: EventLike = {};

    expect(eventCapabilities(legacy, OWNED).canEdit).toBe(true);
    expect(eventCapabilities(legacy, OWNED).isOrganizer).toBe(true);
    expect(eventCapabilities(legacy, SHARED_READ_ONLY).canEdit).toBe(false);
  });
});
