// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import {
  MAX_LOOKUP_DAYS,
  localDateRange,
} from "../../../convex/domains/assistant/eventLogic";

process.env.SKIP_ENV_VALIDATION = "1";
const { ASSISTANT_TOOLS } = await import(
  "../../../convex/domains/assistant/tools"
);

const iso = (ms: number) => new Date(ms).toISOString();

describe("localDateRange", () => {
  test("resolves one day to the user's local midnights", () => {
    const la = localDateRange("2026-11-23", "2026-11-23", "America/Los_Angeles");
    expect(iso(la.fromMs)).toBe("2026-11-23T08:00:00.000Z");
    expect(iso(la.toMs)).toBe("2026-11-24T08:00:00.000Z");
    expect(la.days).toEqual(["2026-11-23"]);

    const london = localDateRange("2026-11-23", "2026-11-23", "Europe/London");
    expect(iso(london.fromMs)).toBe("2026-11-23T00:00:00.000Z");
    expect(iso(london.toMs)).toBe("2026-11-24T00:00:00.000Z");

    const addis = localDateRange("2026-11-24", "2026-11-24", "Africa/Addis_Ababa");
    expect(iso(addis.fromMs)).toBe("2026-11-23T21:00:00.000Z");
    expect(iso(addis.toMs)).toBe("2026-11-24T21:00:00.000Z");
  });

  test("uses British Summer Time in summer", () => {
    const range = localDateRange("2026-07-01", "2026-07-01", "Europe/London");
    expect(iso(range.fromMs)).toBe("2026-06-30T23:00:00.000Z");
    expect(iso(range.toMs)).toBe("2026-07-01T23:00:00.000Z");
  });

  test("keeps DST days at their real 23 or 25 hours", () => {
    const spring = localDateRange("2026-03-08", "2026-03-08", "America/Los_Angeles");
    expect(spring.toMs - spring.fromMs).toBe(23 * 3_600_000);
    const autumn = localDateRange("2026-10-25", "2026-10-25", "Europe/London");
    expect(autumn.toMs - autumn.fromMs).toBe(25 * 3_600_000);
  });

  test("treats toDate as inclusive across a month boundary", () => {
    const range = localDateRange("2026-11-30", "2026-12-02", "Africa/Addis_Ababa");
    expect(range.days).toEqual(["2026-11-30", "2026-12-01", "2026-12-02"]);
    expect(iso(range.toMs)).toBe("2026-12-02T21:00:00.000Z");
  });

  test("refuses backwards, invalid and overlong ranges", () => {
    expect(() => localDateRange("2026-11-24", "2026-11-23", "UTC")).toThrow(
      "toDate must be on or after fromDate",
    );
    expect(() => localDateRange("2026-02-30", "2026-03-01", "UTC")).toThrow(
      "YYYY-MM-DD",
    );
    expect(() => localDateRange("2026-01-01", "2026-12-31", "UTC")).toThrow(
      `${MAX_LOOKUP_DAYS} days`,
    );
    expect(
      localDateRange("2026-01-01", "2026-04-02", "UTC").days,
    ).toHaveLength(MAX_LOOKUP_DAYS);
  });
});

function tool(name: string) {
  const found = ASSISTANT_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing assistant tool ${name}`);
  return found;
}

type QueryArgs = { startMs?: number; endMs?: number };

function contextFor(
  timeZone: string,
  nowMs: number,
  events: Array<Record<string, unknown>>,
) {
  const queries: QueryArgs[] = [];
  const ctx = {
    runQuery: async (_reference: unknown, args: QueryArgs) => {
      queries.push(args);
      // Personal events answer the first query; the shared and booking
      // queries come back empty.
      return queries.length === 1 ? events : [];
    },
  } as unknown as ActionCtx;
  return {
    queries,
    tc: {
      ctx,
      userId: "user-1",
      threadId: "thread-1" as Id<"assistantThreads">,
      timeZone,
      nowMs,
    },
  };
}

describe("assistant read tools take local dates", () => {
  test("expose fromDate/toDate and no epoch-millisecond range", () => {
    for (const name of ["list_events", "find_free_time"]) {
      const { parameters } = tool(name);
      const properties = parameters.properties as Record<string, unknown>;
      expect(properties.fromDate).toBeDefined();
      expect(properties.toDate).toBeDefined();
      expect(properties.fromMs).toBeUndefined();
      expect(properties.toMs).toBeUndefined();
      expect(parameters.required).toContain("fromDate");
      expect(parameters.required).not.toContain("toDate");
    }
  });

  test("keep the cached tool order", () => {
    expect(ASSISTANT_TOOLS.map((t) => t.name)).toEqual([
      "list_events",
      "find_free_time",
      "search_contacts",
      "get_availability_settings",
      "list_pending_booking_requests",
      "create_event",
      "update_event",
      "move_event",
      "delete_event",
      "decide_booking_request",
    ]);
  });

  test("list_events queries the whole local day, evening included", async () => {
    // 7pm on the 23rd in Los Angeles is already the 24th in UTC.
    const evening = {
      _id: "event-1",
      summary: "Dinner",
      startMs: Date.parse("2026-11-24T03:00:00.000Z"),
      endMs: Date.parse("2026-11-24T04:00:00.000Z"),
      allDay: false,
    };
    const { tc, queries } = contextFor(
      "America/Los_Angeles",
      Date.parse("2026-11-23T17:00:00.000Z"),
      [evening],
    );
    const outcome = await tool("list_events").run(tc, "call-1", {
      fromDate: "2026-11-23",
    });

    expect(outcome.kind).toBe("result");
    for (const args of queries) {
      expect(iso(args.startMs!)).toBe("2026-11-23T08:00:00.000Z");
      expect(iso(args.endMs!)).toBe("2026-11-24T08:00:00.000Z");
    }
    const rows = JSON.parse(outcome.content) as Array<{ when: string }>;
    expect(rows[0]?.when).toContain("Nov 23");
    expect(rows[0]?.when).toContain("7:00 PM–8:00 PM");
  });

  test("list_events turns a backwards range into an error result", async () => {
    const { tc } = contextFor("UTC", 0, []);
    const outcome = await tool("list_events").run(tc, "call-1", {
      fromDate: "2026-11-24",
      toDate: "2026-11-23",
    });
    expect(outcome).toMatchObject({ kind: "result", isError: true });
  });

  test("list_events rejects the old epoch-millisecond arguments", async () => {
    const { tc } = contextFor("UTC", 0, []);
    const outcome = await tool("list_events").run(tc, "call-1", {
      fromMs: 0,
      toMs: 1,
    });
    expect(outcome).toMatchObject({ kind: "result", isError: true });
  });

  test("find_free_time walks local days in the user's working hours", async () => {
    // Addis Ababa is UTC+3. Tomorrow is the 24th; a meeting fills 10–11am.
    const meeting = {
      _id: "event-1",
      startMs: Date.parse("2026-11-24T07:00:00.000Z"),
      endMs: Date.parse("2026-11-24T08:00:00.000Z"),
      allDay: false,
      status: "confirmed",
    };
    const { tc, queries } = contextFor(
      "Africa/Addis_Ababa",
      Date.parse("2026-11-23T15:00:00.000Z"),
      [meeting],
    );
    const outcome = await tool("find_free_time").run(tc, "call-1", {
      fromDate: "2026-11-24",
      durationMinutes: 60,
    });

    expect(outcome.kind).toBe("result");
    expect(iso(queries[0]!.startMs!)).toBe("2026-11-23T21:00:00.000Z");
    expect(iso(queries[0]!.endMs!)).toBe("2026-11-24T21:00:00.000Z");
    const result = JSON.parse(outcome.content) as {
      openings: Array<{ startMs: number; latestStartMs: number }>;
    };
    expect(
      result.openings.map((o) => [iso(o.startMs), iso(o.latestStartMs)]),
    ).toEqual([
      // 9–10am, then 11am–6pm local.
      ["2026-11-24T06:00:00.000Z", "2026-11-24T06:00:00.000Z"],
      ["2026-11-24T08:00:00.000Z", "2026-11-24T14:00:00.000Z"],
    ]);
  });

  test("find_free_time never offers time that has already passed", async () => {
    // 4pm in London: only the last two working hours of today remain.
    const { tc } = contextFor(
      "Europe/London",
      Date.parse("2026-11-23T16:00:00.000Z"),
      [],
    );
    const outcome = await tool("find_free_time").run(tc, "call-1", {
      fromDate: "2026-11-23",
      toDate: "2026-11-24",
      durationMinutes: 30,
    });
    const result = JSON.parse(outcome.content) as {
      openings: Array<{ startMs: number; latestStartMs: number }>;
    };
    expect(
      result.openings.map((o) => [iso(o.startMs), iso(o.latestStartMs)]),
    ).toEqual([
      ["2026-11-23T16:00:00.000Z", "2026-11-23T17:30:00.000Z"],
      ["2026-11-24T09:00:00.000Z", "2026-11-24T17:30:00.000Z"],
    ]);
  });
});
