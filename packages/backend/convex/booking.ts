/**
 * Drain-only compatibility facade - keeps the pre-cutover api.booking.* and
 * internal.booking.* paths registered while persisted scheduler entries and
 * stale clients drain. expireBooking entries are scheduled as far out as the
 * 365-day booking horizon, so this facade drains slower than any other.
 * Canonical registration: domains/booking/{queries,mutations,service}.ts.
 * Removal gate: MIGRATION_RUNBOOK.md section 7.
 */

export {
  claimBookingAcceptance,
  claimScheduledBookingAcceptance,
  expireBooking,
  expirePastBookings,
  markAccepted,
  rejectBooking,
  rejectBookingForHost,
  releaseBookingAcceptance,
  requestBooking,
  setOverride,
  upsertBookingPage,
} from "./domains/booking/mutations";
export {
  bookingPageDefaults,
  checkSlugAvailable,
  getBookingByToken,
  getBookingContext,
  getMyBookingPage,
  getPublicPage,
  listMyBookings,
  listMyOverrides,
  listPendingBookings,
  listSlots,
} from "./domains/booking/queries";
export {
  acceptBooking,
  reconcileBookingAcceptance,
} from "./domains/booking/service";
