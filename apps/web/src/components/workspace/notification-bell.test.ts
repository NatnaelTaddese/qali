// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
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
