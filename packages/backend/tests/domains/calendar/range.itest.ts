import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import schema from "../../../convex/schema";
import { readPersonalEventsInRange } from "../../../convex/domains/calendar/queries";

import { modules } from "../../testModules";

test("range read does not scan more than 5000 provider-id-ordered out-of-range events", async () => {
  const t = convexTest(schema, modules);
  const userId = "range-user";
  const calendarId = await t.run((ctx) =>
    ctx.db.insert("calendars", {
      userId,
      googleCalendarId: "primary",
      selected: true,
    }),
  );
  for (let batch = 0; batch < 11; batch++) {
    await t.run(async (ctx) => {
      for (let offset = 0; offset < 500; offset++) {
        const n = batch * 500 + offset;
        await ctx.db.insert("events", {
          userId,
          calendarId: "primary",
          googleEventId: `out-${String(n).padStart(5, "0")}`,
          startMs: n,
          endMs: n + 1,
          allDay: false,
          status: "confirmed",
          googleUpdatedMs: 1,
        });
      }
    });
  }
  await t.run((ctx) =>
    ctx.db.insert("events", {
      userId,
      calendarId: "primary",
      googleEventId: "in-range",
      startMs: 1_000_000,
      endMs: 1_000_100,
      allDay: false,
      status: "confirmed",
      googleUpdatedMs: 1,
    }),
  );

  const rows = await t.run(async (ctx) => {
    const calendar = await ctx.db.get(calendarId);
    return await readPersonalEventsInRange(
      ctx,
      userId,
      [calendar!],
      999_900,
      1_000_200,
    );
  });
  expect(rows.map((row) => row.googleEventId)).toEqual(["in-range"]);
});
