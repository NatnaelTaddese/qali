// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
  EMPTY_SEEN,
  newBookingRequests,
  notificationTriggerLabel,
  shouldActivateNotificationRow,
} from "./notification-bell";

describe("notificationTriggerLabel", () => {
  test("announces capped unread counts as a lower bound", () => {
    expect(notificationTriggerLabel(10)).toBe(
      "Notifications, 10 or more unread",
    );
  });

  test("announces exact counts below the cap", () => {
    expect(notificationTriggerLabel(3)).toBe("Notifications, 3 unread");
    expect(notificationTriggerLabel(0)).toBe("Notifications");
  });
});

describe("shouldActivateNotificationRow", () => {
  test("accepts Enter and Space when the row owns the event", () => {
    expect(shouldActivateNotificationRow("Enter", true)).toBe(true);
    expect(shouldActivateNotificationRow(" ", true)).toBe(true);
  });

  test("ignores keyboard events bubbled from the dismiss button", () => {
    expect(shouldActivateNotificationRow("Enter", false)).toBe(false);
    expect(shouldActivateNotificationRow(" ", false)).toBe(false);
  });
});

describe("newBookingRequests", () => {
  const request = (id: string, createdAt: number) =>
    ({ _id: id, type: "booking_requested", createdAt }) as const;
  const reminder = (id: string, createdAt: number) =>
    ({ _id: id, type: "event_reminder", createdAt }) as const;

  test("chimes for a booking request it hasn't shown", () => {
    const baseline = newBookingRequests([request("a", 100)], EMPTY_SEEN).next;
    const { chime, next } = newBookingRequests(
      [request("b", 200), request("a", 100)],
      baseline,
    );
    expect(chime).toBe(true);
    expect([...next.ids].sort()).toEqual(["a", "b"]);
    expect(next.maxCreatedAt).toBe(200);
  });

  test("never chimes for reminder rows", () => {
    const baseline = newBookingRequests([], EMPTY_SEEN).next;
    expect(newBookingRequests([reminder("r", 100)], baseline).chime).toBe(false);
  });

  test("stays quiet across read and dismiss churn", () => {
    const rows = [request("a", 100), request("b", 200)];
    const baseline = newBookingRequests(rows, EMPTY_SEEN).next;
    expect(newBookingRequests(rows, baseline).chime).toBe(false);
    expect(newBookingRequests([rows[0]], baseline).chime).toBe(false);
  });

  test("ignores an old row re-entering the feed window", () => {
    const baseline = newBookingRequests([request("b", 200)], EMPTY_SEEN).next;
    // "a" predates everything the bell has seen: it scrolled back in after a
    // dismiss rather than arriving now.
    expect(newBookingRequests([request("a", 100)], baseline).chime).toBe(false);
  });

  test("keeps the high-water mark through an empty result", () => {
    const baseline = newBookingRequests([request("a", 100)], EMPTY_SEEN).next;
    const { next } = newBookingRequests([], baseline);
    expect(next.maxCreatedAt).toBe(100);
    expect(next.ids.size).toBe(0);
  });
});
