/** The pure half of the client reminder scheduler: bucketing, due state, and
 * the diff between what is scheduled and what the server now says. */

import { MS_PER_HOUR, MS_PER_MINUTE } from "@/components/calendar/lib";

/** How far ahead the tab keeps timers. Anything later arrives on a later
 * bucket's query. */
export const HORIZON_MS = 24 * MS_PER_HOUR;
/** A reminder found already past by more than this (a throttled tab, a
 * laptop lid) is not worth nagging about. */
export const GRACE_MS = 10 * MS_PER_MINUTE;
/** The `fromMs` the tab subscribes with is rounded to this, so the query key
 * only changes every few minutes rather than on every render. */
export const BUCKET_MS = 5 * MS_PER_MINUTE;

export interface UpcomingReminder {
  readonly eventId: string;
  readonly summary?: string;
  readonly startMs: number;
  readonly allDay: boolean;
  readonly fireAtMs: number;
  readonly minutes: number;
}

export function reminderKey(r: Pick<UpcomingReminder, "eventId" | "minutes">): string {
  return `${r.eventId}:${r.minutes}`;
}

export function bucketNow(nowMs: number): number {
  return Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
}

export type DueState = "future" | "due" | "stale";

export function dueState(fireAtMs: number, nowMs: number): DueState {
  if (fireAtMs > nowMs) return "future";
  return nowMs - fireAtMs <= GRACE_MS ? "due" : "stale";
}

/** Which keys to cancel and which reminders to (re)schedule. A reminder whose
 * fire time moved counts as removed then added. */
export function diffReminders(
  scheduled: ReadonlyMap<string, number>,
  next: readonly UpcomingReminder[],
): { added: UpcomingReminder[]; removed: string[] } {
  const wanted = new Map(next.map((r) => [reminderKey(r), r]));
  const removed: string[] = [];
  for (const [key, fireAtMs] of scheduled) {
    const want = wanted.get(key);
    if (!want || want.fireAtMs !== fireAtMs) removed.push(key);
  }
  const added: UpcomingReminder[] = [];
  for (const [key, r] of wanted) {
    const current = scheduled.get(key);
    if (current === undefined || current !== r.fireAtMs) added.push(r);
  }
  return { added, removed };
}
