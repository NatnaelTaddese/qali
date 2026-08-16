/**
 * Public booking pages: a host publishes a weekly schedule at `/<slug>`, anyone
 * opens that link and requests a time, and the host accepts or rejects it.
 *
 * This is the app's only anonymous surface. The logic lives in `domains/booking/`;
 * this file is the stable facade that keeps every `api.booking.*` /
 * `internal.booking.*` path and argument shape fixed.
 */

import { v } from "convex/values";

import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { slotSettingsValidator } from "./domains/booking/model";
import {
  claimBookingAcceptanceHandler,
  expireBookingHandler,
  expirePastBookingsHandler,
  markAcceptedHandler,
  rejectBookingForHostHandler,
  rejectBookingHandler,
  releaseBookingAcceptanceHandler,
  requestBookingHandler,
  setOverrideHandler,
  upsertBookingPageHandler,
} from "./domains/booking/mutations";
import {
  bookingPageDefaultsHandler,
  checkSlugAvailableHandler,
  getBookingByTokenHandler,
  getBookingContextHandler,
  getMyBookingPageHandler,
  getPublicPageHandler,
  listMyBookingsHandler,
  listMyOverridesHandler,
  listPendingBookingsHandler,
  listSlotsHandler,
} from "./domains/booking/queries";
import { acceptBookingHandler } from "./domains/booking/service";

// --- Host: the page and its schedule -------------------------------------

export const getMyBookingPage = query({
  args: {},
  handler: (ctx) => getMyBookingPageHandler(ctx),
});

export const checkSlugAvailable = query({
  args: { slug: v.string() },
  handler: (ctx, args) => checkSlugAvailableHandler(ctx, args),
});

export const upsertBookingPage = mutation({
  args: {
    slug: v.string(),
    /** IANA zone the weekly rules are expressed in; the client sends its own. */
    timeZone: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    rules: v.array(
      v.object({
        weekday: v.number(),
        startMin: v.number(),
        endMin: v.number(),
      }),
    ),
    ...slotSettingsValidator,
    enabled: v.boolean(),
  },
  handler: (ctx, args) => upsertBookingPageHandler(ctx, args),
});

export const bookingPageDefaults = query({
  args: {},
  handler: (ctx) => bookingPageDefaultsHandler(ctx),
});

export const setOverride = mutation({
  args: {
    dateKey: v.string(),
    intervals: v.optional(
      v.array(v.object({ startMin: v.number(), endMin: v.number() })),
    ),
  },
  handler: (ctx, args) => setOverrideHandler(ctx, args),
});

export const listMyOverrides = query({
  args: {},
  handler: (ctx) => listMyOverridesHandler(ctx),
});

export const listMyBookings = query({
  args: { startMs: v.number(), endMs: v.number() },
  handler: (ctx, args) => listMyBookingsHandler(ctx, args),
});

export const listPendingBookings = query({
  args: {},
  handler: (ctx) => listPendingBookingsHandler(ctx),
});

export const expireBooking = internalMutation({
  args: { bookingId: v.id("bookings") },
  handler: (ctx, args) => expireBookingHandler(ctx, args),
});

export const expirePastBookings = internalMutation({
  args: {},
  handler: (ctx) => expirePastBookingsHandler(ctx),
});

// --- Public: the booking page itself --------------------------------------

export const getPublicPage = query({
  args: { slug: v.string() },
  handler: (ctx, args) => getPublicPageHandler(ctx, args),
});

export const listSlots = query({
  args: { slug: v.string(), fromMs: v.number(), toMs: v.number() },
  handler: (ctx, args) => listSlotsHandler(ctx, args),
});

export const requestBooking = mutation({
  args: {
    slug: v.string(),
    startMs: v.number(),
    name: v.string(),
    email: v.string(),
    note: v.optional(v.string()),
    /** The visitor's IANA zone, recorded so the host can see what time they
     * thought they were booking. Display only. */
    timeZone: v.string(),
  },
  handler: (ctx, args) => requestBookingHandler(ctx, args),
});

export const getBookingByToken = query({
  args: { token: v.string() },
  handler: (ctx, args) => getBookingByTokenHandler(ctx, args),
});

// --- Acceptance lifecycle -------------------------------------------------

export const getBookingContext = internalQuery({
  args: { bookingId: v.id("bookings"), hostUserId: v.string() },
  handler: (ctx, args) => getBookingContextHandler(ctx, args),
});

export const markAccepted = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hostUserId: v.string(),
    providerEventId: v.string(),
    providerCalendarId: v.string(),
    attemptId: v.string(),
  },
  handler: (ctx, args) => markAcceptedHandler(ctx, args),
});

export const claimBookingAcceptance = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hostUserId: v.string(),
    attemptId: v.string(),
  },
  handler: (ctx, args) => claimBookingAcceptanceHandler(ctx, args),
});

export const releaseBookingAcceptance = internalMutation({
  args: {
    bookingId: v.id("bookings"),
    hostUserId: v.string(),
    attemptId: v.string(),
    mayHaveSucceeded: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: (ctx, args) => releaseBookingAcceptanceHandler(ctx, args),
});

export const acceptBooking = action({
  args: { bookingId: v.id("bookings") },
  handler: (ctx, args) => acceptBookingHandler(ctx, args),
});

export const rejectBooking = mutation({
  args: { bookingId: v.id("bookings") },
  handler: (ctx, args) => rejectBookingHandler(ctx, args),
});

export const rejectBookingForHost = internalMutation({
  args: { bookingId: v.id("bookings"), hostUserId: v.string() },
  handler: (ctx, args) => rejectBookingForHostHandler(ctx, args),
});
