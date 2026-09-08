// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
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
  const request = (createdAt: number) =>
    ({ type: "booking_requested", createdAt }) as const;
  const reminder = (createdAt: number) =>
    ({ type: "event_reminder", createdAt }) as const;

  test("the first result sets the baseline without chiming", () => {
    const { chime, next } = newBookingRequests([request(100)], null);
    expect(chime).toBe(false);
    expect(next).toBe(100);
  });

  test("chimes for a booking request newer than the mark", () => {
    const { chime, next } = newBookingRequests([request(200), request(100)], 100);
    expect(chime).toBe(true);
    expect(next).toBe(200);
  });

  test("never chimes for reminder rows, and they don't move the mark", () => {
    const { chime, next } = newBookingRequests([reminder(500)], 100);
    expect(chime).toBe(false);
    expect(next).toBe(100);
  });

  test("a reminder row landing first can't mask a slightly older booking", () => {
    const afterReminder = newBookingRequests([reminder(300)], 100).next;
    expect(newBookingRequests([request(250), reminder(300)], afterReminder).chime).toBe(
      true,
    );
  });

  test("stays quiet across read and dismiss churn", () => {
    const rows = [request(100), request(200)];
    const mark = newBookingRequests(rows, null).next;
    expect(newBookingRequests(rows, mark).chime).toBe(false);
    expect(newBookingRequests([rows[0]], mark).chime).toBe(false);
  });

  test("ignores an old row re-entering the feed window", () => {
    // It predates everything the bell has seen: it scrolled back in after a
    // dismiss rather than arriving now.
    expect(newBookingRequests([request(100)], 200).chime).toBe(false);
  });

  test("keeps the mark through an empty result", () => {
    expect(newBookingRequests([], 100).next).toBe(100);
  });
});
