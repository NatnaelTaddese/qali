// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import { googleEventIdForOperation, mergeLiveAttendees } from "../../../convex/integrations/google/eventHelpers";

describe("mergeLiveAttendees", () => {
  test("preserves live RSVP/resource fields and protected attendees", () => {
    const merged = mergeLiveAttendees(
      [
        { email: "owner@example.com", organizer: true, responseStatus: "accepted" },
        {
          email: "room@example.com",
          resource: true,
          responseStatus: "accepted",
          comment: "Projector",
        },
        { email: "removed@example.com", responseStatus: "tentative" },
      ],
      [
        { email: "room@example.com" },
        { email: "new@example.com", optional: true },
      ],
    );

    expect(merged).toContainEqual({
      email: "room@example.com",
      resource: true,
      responseStatus: "accepted",
      comment: "Projector",
    });
    expect(merged).toContainEqual({
      email: "owner@example.com",
      organizer: true,
      responseStatus: "accepted",
    });
    expect(merged.some((a) => a.email === "removed@example.com")).toBe(false);
  });
});

test("operation IDs become stable Google IDs", () => {
  const id = googleEventIdForOperation("123e4567-e89b-12d3-a456-426614174000");
  expect(id).toBe("qali123e4567e89b12d3a456426614174000");
  expect(id).toMatch(/^[a-v0-9]+$/);
});
