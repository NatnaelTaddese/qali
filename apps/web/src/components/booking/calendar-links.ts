/**
 * Client-side "add to calendar" builders for the booking confirmation. Once the
 * host accepts, Google's own invitation is on its way by email — these are just
 * a convenience so the requester can drop the meeting into whatever calendar
 * they read, without waiting on that mail. Everything is derived from the
 * instants and names the confirmation already holds; nothing new is fetched.
 */

export interface CalendarEventInput {
  title: string;
  startMs: number;
  endMs: number;
  description?: string;
}

/** Instant → the basic-format UTC stamp both Google and iCalendar accept, e.g.
 * `20260715T130000Z`. */
function toUtcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** A Google Calendar "create event" template URL, pre-filled and opened in a new
 * tab. Times are sent in UTC (the trailing `Z`), so Google renders them in the
 * viewer's own zone. */
export function buildGoogleUrl({
  title,
  startMs,
  endMs,
  description,
}: CalendarEventInput): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${toUtcStamp(startMs)}/${toUtcStamp(endMs)}`,
  });
  if (description) params.set("details", description);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Escape a text value for an iCalendar property per RFC 5545 §3.3.11. */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** A minimal single-event `.ics` document. CRLF line endings, as the spec
 * requires for the widest client support (Apple Calendar, Outlook). */
export function buildIcs({
  title,
  startMs,
  endMs,
  description,
}: CalendarEventInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//qali//booking//EN",
    "BEGIN:VEVENT",
    `UID:${startMs}-${endMs}@qali.app`,
    `DTSTAMP:${toUtcStamp(Date.now())}`,
    `DTSTART:${toUtcStamp(startMs)}`,
    `DTEND:${toUtcStamp(endMs)}`,
    `SUMMARY:${escapeIcsText(title)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

/** Trigger a download of the event as an `.ics` file. Browser-only. */
export function downloadIcs(event: CalendarEventInput): void {
  const blob = new Blob([buildIcs(event)], {
    type: "text/calendar;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "meeting.ics";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the click's navigation has already begun.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
