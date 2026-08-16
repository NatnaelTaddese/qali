import {
  addDaysToDateKey,
  MS_PER_DAY,
  utcToZoned,
  zonedToUtcMs,
} from "@qali/domain/availability";

/** Shift a recurring master by the edit made to one expanded occurrence.
 * Crossing between timed and all-day representations is wall-clock/date math,
 * not epoch-delta math, because the master and occurrence may be in different
 * daylight-saving offsets. */
export function shiftRecurringMasterRange(args: {
  occurrenceStartMs: number;
  occurrenceEndMs: number;
  occurrenceAllDay: boolean;
  masterStartMs: number;
  masterEndMs: number;
  masterAllDay: boolean;
  targetStartMs: number;
  targetEndMs: number;
  targetAllDay: boolean;
  timeZone?: string;
}): { startMs: number; endMs: number } {
  if (args.targetAllDay === args.occurrenceAllDay) {
    return {
      startMs:
        args.masterStartMs + (args.targetStartMs - args.occurrenceStartMs),
      endMs: args.masterEndMs + (args.targetEndMs - args.occurrenceEndMs),
    };
  }
  if (!args.timeZone) {
    throw new Error("A time zone is required to change a recurring event type");
  }

  const sourceOccurrenceDate = args.occurrenceAllDay
    ? new Date(args.occurrenceStartMs).toISOString().slice(0, 10)
    : utcToZoned(args.occurrenceStartMs, args.timeZone).dateKey;
  const sourceMasterDate = args.masterAllDay
    ? new Date(args.masterStartMs).toISOString().slice(0, 10)
    : utcToZoned(args.masterStartMs, args.timeZone).dateKey;
  const target = args.targetAllDay
    ? {
        dateKey: new Date(args.targetStartMs).toISOString().slice(0, 10),
        minutes: 0,
      }
    : utcToZoned(args.targetStartMs, args.timeZone);
  const dayDelta = Math.round(
    (Date.parse(`${target.dateKey}T00:00:00.000Z`) -
      Date.parse(`${sourceOccurrenceDate}T00:00:00.000Z`)) /
      MS_PER_DAY,
  );
  const masterTargetDate = addDaysToDateKey(sourceMasterDate, dayDelta);
  const startMs = args.targetAllDay
    ? Date.parse(`${masterTargetDate}T00:00:00.000Z`)
    : zonedToUtcMs(masterTargetDate, target.minutes, args.timeZone);
  return {
    startMs,
    endMs: startMs + (args.targetEndMs - args.targetStartMs),
  };
}
