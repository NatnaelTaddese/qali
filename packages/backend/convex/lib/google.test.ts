// @ts-expect-error Bun supplies its test module at runtime; the Convex
// TypeScript project intentionally does not include Bun's ambient types.
import { afterEach, describe, expect, test } from "bun:test";

import { fetchCalendarList } from "./google";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchCalendarList", () => {
  test("paginates and maps non-hidden calendar metadata", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      const pageToken = new URL(url).searchParams.get("pageToken");
      if (!pageToken) {
        return Response.json({
          items: [
            {
              id: "primary@example.com",
              summary: "Primary",
              summaryOverride: "My calendar",
              backgroundColor: "#123456",
              foregroundColor: "#ffffff",
              primary: true,
              accessRole: "owner",
              timeZone: "Asia/Shanghai",
              selected: true,
            },
            { id: "hidden@example.com", hidden: true },
            { id: "deleted@example.com", deleted: true },
          ],
          nextPageToken: "next-page",
        });
      }
      return Response.json({
        items: [
          {
            id: "team@example.com",
            summary: "Team",
            accessRole: "reader",
            selected: false,
          },
        ],
      });
    }) as typeof fetch;

    const calendars = await fetchCalendarList("access-token");

    expect(calendars).toEqual([
      {
        googleCalendarId: "primary@example.com",
        summary: "Primary",
        summaryOverride: "My calendar",
        backgroundColor: "#123456",
        foregroundColor: "#ffffff",
        primary: true,
        accessRole: "owner",
        timeZone: "Asia/Shanghai",
        googleSelected: true,
      },
      {
        googleCalendarId: "team@example.com",
        summary: "Team",
        summaryOverride: undefined,
        backgroundColor: undefined,
        foregroundColor: undefined,
        primary: undefined,
        accessRole: "reader",
        timeZone: undefined,
        googleSelected: false,
      },
    ]);
    expect(requestedUrls).toHaveLength(2);
    expect(new URL(requestedUrls[0]).searchParams.get("showHidden")).toBe(
      "false",
    );
    expect(new URL(requestedUrls[1]).searchParams.get("pageToken")).toBe(
      "next-page",
    );
  });
});
