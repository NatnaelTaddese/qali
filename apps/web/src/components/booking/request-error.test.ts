import { ConvexError } from "convex/values";
// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { bookingRequestErrorMessage } from "./request-error";

describe("bookingRequestErrorMessage", () => {
  test("maps the per-email request limit", () => {
    expect(
      bookingRequestErrorMessage(new ConvexError({ code: "EMAIL_RATE_LIMIT" })),
    ).toEqual({
      title: "Too many requests",
      description:
        "You've already sent several booking requests. Please wait a while before trying again.",
    });
  });

  test("recognizes the legacy wrapped server error", () => {
    const error = new Error(
      "[CONVEX M(booking:requestBooking)] Server Error Uncaught Error: You've sent several requests already - try again later",
    );
    expect(bookingRequestErrorMessage(error).title).toBe("Too many requests");
  });

  test("maps the page-wide request limit", () => {
    expect(
      bookingRequestErrorMessage(new ConvexError({ code: "PAGE_RATE_LIMIT" })),
    ).toEqual({
      title: "Booking page is busy",
      description:
        "This page has received too many requests recently. Please try again later.",
    });
  });

  test("does not expose unknown server details", () => {
    const result = bookingRequestErrorMessage(
      new Error("[Request ID: secret] Internal server details"),
    );
    expect(result).toEqual({
      title: "Couldn't send your request",
      description: "Something went wrong. Please try again.",
    });
  });
});
