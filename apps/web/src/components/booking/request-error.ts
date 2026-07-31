import { ConvexError } from "convex/values";

interface BookingRequestErrorMessage {
  title: string;
  description: string;
}

/** Convert expected public-booking failures into safe copy. Never expose the
 * raw Convex message here: it can contain request IDs and server stack details. */
export function bookingRequestErrorMessage(
  error: unknown,
): BookingRequestErrorMessage {
  const code =
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    "code" in error.data
      ? error.data.code
      : undefined;

  if (
    code === "EMAIL_RATE_LIMIT" ||
    (error instanceof Error &&
      error.message.includes("You've sent several requests already"))
  ) {
    return {
      title: "Too many requests",
      description:
        "You've already sent several booking requests. Please wait a while before trying again.",
    };
  }

  if (
    code === "PAGE_RATE_LIMIT" ||
    (error instanceof Error &&
      error.message.includes("This page has taken too many requests recently"))
  ) {
    return {
      title: "Booking page is busy",
      description:
        "This page has received too many requests recently. Please try again later.",
    };
  }

  return {
    title: "Couldn't send your request",
    description: "Something went wrong. Please try again.",
  };
}
