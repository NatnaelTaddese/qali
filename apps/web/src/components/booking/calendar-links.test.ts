// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { buildGoogleUrl, buildIcs } from "./calendar-links";



// A fixed instant so the UTC stamps are stable regardless of the test host's
// zone: 2026-08-05T03:30:00Z for 30 minutes.
const startMs = Date.UTC(2026, 7, 5, 3, 30, 0);
const endMs = startMs + 30 * 60_000;
const event = {
  title: "Coffee chat",
  startMs,
  endMs,
  description: "Booked with Ada Lovelace via qali.",
};

describe("buildGoogleUrl", () => {
  test("carries UTC start/end and the title", () => {
    const url = new URL(buildGoogleUrl(event));
    expect(url.origin + url.pathname).toBe(
      "https://calendar.google.com/calendar/render",
    );
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Coffee chat");
    expect(url.searchParams.get("dates")).toBe(
      "20260805T033000Z/20260805T040000Z",
    );
    expect(url.searchParams.get("details")).toBe(event.description);
  });
});

describe("buildIcs", () => {
  test("is a well-formed single VEVENT with CRLF lines and UTC stamps", () => {
    const ics = buildIcs(event);
    const lines = ics.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("DTSTART:20260805T033000Z");
    expect(ics).toContain("DTEND:20260805T040000Z");
    expect(ics).toContain("SUMMARY:Coffee chat");
  });

  test("escapes reserved characters in text values", () => {
    const ics = buildIcs({
      ...event,
      title: "Chat; about, compilers\nand more",
    });
    expect(ics).toContain("SUMMARY:Chat\\; about\\, compilers\\nand more");
  });
});

describe("buildIcs escaping", () => {
  test("escapes every line-break flavour in text values", () => {
    const ics = buildIcs({
      title: "one\rtwo\nthree\r\nfour",
      startMs,
      endMs,
    });
    expect(ics).toContain("SUMMARY:one\\ntwo\\nthree\\nfour");
    // No bare CR or LF may survive inside a property value.
    const summary = ics.split("\r\n").find((line) => line.startsWith("SUMMARY:"));
    expect(summary).toBe("SUMMARY:one\\ntwo\\nthree\\nfour");
  });
});
