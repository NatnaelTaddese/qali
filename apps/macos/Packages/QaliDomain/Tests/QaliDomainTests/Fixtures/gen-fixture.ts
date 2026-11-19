import { layoutDayEvents, WEEK_LANE_TILE_MAX_STAGGER_MS, bucketDayEvents } from "../../../../../../../packages/domain/src/calendar/layout";
import { layoutAllDayEvents } from "../../../../../../../packages/domain/src/calendar/allday";
import { stripDays, eventQueryRange } from "../../../../../../../packages/domain/src/calendar/paging";
import { zoned } from "../../../../../../../packages/domain/src/calendar/zone";

// Deterministic LCG so the fixture is reproducible.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const zone = process.env.TZ!;
const anchor = zoned(Date.parse("2026-03-06T12:00:00Z"), zone); // spans a US DST change
const days = stripDays(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate()), 3, 6);
const dayStart = days[6].getTime();

const scenarios = [0, 1, 2].map((s) => {
  const timed = Array.from({ length: 40 }, (_, i) => {
    const start = dayStart + Math.floor(rand() * 96) * 15 * 60_000 - (rand() < 0.1 ? 3 * 3600_000 : 0);
    const len = (1 + Math.floor(rand() * 12)) * 15 * 60_000;
    return { _id: `t${s}-${i}`, startMs: start, endMs: start + len, allDay: false };
  });
  const base = Date.UTC(2026, 2, 6 - 6);
  const allDay = Array.from({ length: 25 }, (_, i) => {
    const startDay = Math.floor(rand() * 15) - 1;
    const len = 1 + Math.floor(rand() * 4);
    return { _id: `a${s}-${i}`, startMs: base + startDay * 86400000, endMs: base + (startDay + len) * 86400000, allDay: true };
  });
  const pick = (p: any) => ({ id: p.event._id, topPct: p.topPct, heightPct: p.heightPct, stackIndex: p.stackIndex, stackCount: p.stackCount, elevation: p.elevation, columnIndex: p.columnIndex, columnCount: p.columnCount, columnSpan: p.columnSpan, laneAdvance: p.laneAdvance });
  const bucket = bucketDayEvents(days, [...timed, ...allDay]);
  return {
    timed, allDay,
    dayLayout: layoutDayEvents(timed, dayStart).map(pick),
    weekLayout: layoutDayEvents(timed, dayStart, WEEK_LANE_TILE_MAX_STAGGER_MS).map(pick),
    allDayLayout: layoutAllDayEvents(days, allDay, 5, 9).map((e) => ({ id: e.event._id, startIdx: e.startIdx, endIdx: e.endIdx, lane: e.lane })),
    bucket: { allDay: bucket.allDayEvents.map((e) => e._id), timedByDay: bucket.timedByDay.map((d) => d.map((e) => e._id)) },
  };
});
console.log(JSON.stringify({ zone, days: days.map((d) => d.getTime()), dayStart, queryRange: eventQueryRange("week", days[6], 1), scenarios }));
