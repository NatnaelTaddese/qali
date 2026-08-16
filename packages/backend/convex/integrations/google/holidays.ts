/** Only generated Google holiday calendars are globally viewer-independent. */
export function isGoogleSharedHolidayCalendar(calendarId: string): boolean {
  return calendarId.endsWith("#holiday@group.v.calendar.google.com");
}
