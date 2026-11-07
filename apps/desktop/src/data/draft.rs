//! The form's time and reminder controls, as pure steps over `[start, end)`: timed events
//! move in quarter hours and keep their length when the start moves; all-day events are
//! whole UTC days (Google's all-day bounds), the end exclusive.

use chrono::{DateTime, Days, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;

use super::days::start_of_day_ms;
use super::models::CalendarEvent;
use super::week::{MS_PER_DAY, SNAP_MS};

/// Reminder presets in minutes before (`REMINDER_PRESETS` on the web).
pub const TIMED_REMINDERS: [f64; 5] = [5.0, 10.0, 30.0, 60.0, 1440.0];
/// The day before at 9:00, and the week before at 9:00.
pub const ALL_DAY_REMINDERS: [f64; 2] = [900.0, 9540.0];

fn local(ms: f64, zone: Tz) -> DateTime<Tz> {
    zone.timestamp_millis_opt(ms as i64).earliest().unwrap_or_else(|| zone.timestamp_millis_opt(0).unwrap())
}

fn utc_date(ms: f64) -> NaiveDate {
    DateTime::<Utc>::from_timestamp_millis(ms as i64).unwrap_or_default().date_naive()
}

fn utc_midnight(date: NaiveDate) -> f64 {
    date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis() as f64
}

/// The start moved by `delta`, the end following so the length stays.
pub fn shift_start(start: f64, end: f64, delta: f64) -> (f64, f64) {
    (start + delta, end + delta)
}

/// The end moved by `delta`, never closer than a quarter hour to the start.
pub fn shift_end(start: f64, end: f64, delta: f64) -> (f64, f64) {
    (start, (end + delta).max(start + SNAP_MS))
}

/// Both moved `days` days: the same wall-clock start in `zone` (DST-aware), the same length.
/// All-day bounds move whole UTC days.
pub fn shift_days(start: f64, end: f64, days: i64, all_day: bool, zone: Tz) -> (f64, f64) {
    if all_day {
        let d = days as f64 * MS_PER_DAY;
        return (start + d, end + d);
    }
    let from = local(start, zone).naive_local();
    let to = if days >= 0 { from.checked_add_days(Days::new(days as u64)) } else { from.checked_sub_days(Days::new(days.unsigned_abs())) };
    let Some(to) = to else { return (start, end) };
    let moved = zone.from_local_datetime(&to).earliest().map_or(start + days as f64 * MS_PER_DAY, |t| t.timestamp_millis() as f64);
    (moved, moved + (end - start))
}

/// An all-day event's last day moved `days`, keeping at least one day.
pub fn shift_last_day(start: f64, end: f64, days: i64) -> (f64, f64) {
    (start, (end + days as f64 * MS_PER_DAY).max(start + MS_PER_DAY))
}

/// The days a timed `[start, end)` touches in `zone`, as all-day bounds.
pub fn to_all_day(start: f64, end: f64, zone: Tz) -> (f64, f64) {
    let first = local(start, zone).date_naive();
    let last = local((end - 1.0).max(start), zone).date_naive().max(first);
    (utc_midnight(first), utc_midnight(last) + MS_PER_DAY)
}

/// An all-day event's first day as a timed hour, 9:00–10:00 in `zone`.
pub fn to_timed(start: f64, zone: Tz) -> (f64, f64) {
    let nine = start_of_day_ms(utc_date(start), zone) + 9.0 * 3_600_000.0;
    (nine, nine + 3_600_000.0)
}

/// The last day an all-day event covers (its end is exclusive).
pub fn last_day_ms(start: f64, end: f64) -> f64 {
    (end - MS_PER_DAY).max(start)
}

/// A new event's length when nothing else says (`DEFAULT_EVENT_DURATION_MS`).
pub const DEFAULT_DURATION_MS: f64 = 30.0 * 60_000.0;

/// `nextFreeSlot`: where Create and N put a new event on the day `[day_start, day_end)`.
/// From 9:00, or on today the next quarter hour from now if later, it skips past each timed
/// event in the way; a full day falls back to its last slot before midnight.
pub fn next_free_slot(day_start: f64, day_end: f64, events: &[CalendarEvent], now_ms: f64) -> (f64, f64) {
    let nine = day_start + 9.0 * 3_600_000.0;
    let today = now_ms >= day_start && now_ms < day_end;
    let mut start = if today { nine.max((now_ms / SNAP_MS).ceil() * SNAP_MS) } else { nine };
    let last_start = day_end - DEFAULT_DURATION_MS;
    let mut timed: Vec<&CalendarEvent> = events.iter().filter(|e| !e.all_day).collect();
    timed.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    while start <= last_start {
        let end = start + DEFAULT_DURATION_MS;
        match timed.iter().find(|e| e.start_ms < end && e.end_ms > start) {
            None => return (start, end),
            // Jump past the blocking event, snapped forward, not a quarter hour at a time.
            Some(clash) => start = (start + SNAP_MS).max((clash.end_ms / SNAP_MS).ceil() * SNAP_MS),
        }
    }
    (last_start, last_start + DEFAULT_DURATION_MS)
}

/// A reminder chip pressed: the calendar's default becomes just this one, and otherwise it
/// toggles in the list (which may end empty: no reminders).
pub fn toggle_reminder(reminders: &Option<Vec<f64>>, minutes: f64) -> Option<Vec<f64>> {
    let mut list = reminders.clone().unwrap_or_default();
    if let Some(i) = list.iter().position(|m| *m == minutes) {
        list.remove(i);
    } else {
        list.push(minutes);
        list.sort_by(f64::total_cmp);
    }
    Some(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NY: Tz = chrono_tz::America::New_York;
    const H: f64 = 3_600_000.0;

    fn ny(m: u32, d: u32, h: u32) -> f64 {
        NY.with_ymd_and_hms(2026, m, d, h, 0, 0).unwrap().timestamp_millis() as f64
    }

    #[test]
    fn start_keeps_the_length_and_end_keeps_a_quarter_hour() {
        assert_eq!(shift_start(10.0 * H, 11.0 * H, SNAP_MS), (10.25 * H, 11.25 * H));
        assert_eq!(shift_end(10.0 * H, 10.25 * H, -SNAP_MS), (10.0 * H, 10.25 * H));
        assert_eq!(shift_end(10.0 * H, 11.0 * H, SNAP_MS), (10.0 * H, 11.25 * H));
    }

    #[test]
    fn days_keep_the_wall_clock_across_dst() {
        // Sat 31 Oct 10:00 EDT → Sun 1 Nov 10:00 EST: 25 hours later.
        let (start, end) = shift_days(ny(10, 31, 10), ny(10, 31, 11), 1, false, NY);
        assert_eq!((start, end), (ny(11, 1, 10), ny(11, 1, 11)));
        assert_eq!(shift_days(ny(11, 1, 10), ny(11, 1, 11), -1, false, NY).0, ny(10, 31, 10));
    }

    #[test]
    fn all_day_round_trips() {
        let utc = |d: u32| Utc.with_ymd_and_hms(2026, 11, d, 0, 0, 0).unwrap().timestamp_millis() as f64;
        // 11 PM to 1 AM touches two days; a meeting ending at midnight only one.
        assert_eq!(to_all_day(ny(11, 11, 23), ny(11, 12, 1), NY), (utc(11), utc(13)));
        assert_eq!(to_all_day(ny(11, 11, 15), ny(11, 12, 0), NY), (utc(11), utc(12)));
        assert_eq!(to_timed(utc(11), NY), (ny(11, 11, 9), ny(11, 11, 10)));
        assert_eq!(shift_last_day(utc(11), utc(12), -1), (utc(11), utc(12)), "at least one day");
        assert_eq!(shift_last_day(utc(11), utc(12), 2), (utc(11), utc(14)));
        assert_eq!(last_day_ms(utc(11), utc(13)), utc(12));
    }

    #[test]
    fn the_next_free_slot_skips_what_is_in_the_way() {
        let day = ny(11, 11, 0);
        let end = ny(11, 12, 0);
        let event = |s: f64, e: f64| CalendarEvent { start_ms: day + s * H, end_ms: day + e * H, ..Default::default() };
        // Another day: 9:00, past a 9:00–10:10 meeting to 10:15.
        assert_eq!(next_free_slot(day, end, &[], ny(11, 10, 12)), (day + 9.0 * H, day + 9.5 * H));
        assert_eq!(next_free_slot(day, end, &[event(9.0, 10.0 + 10.0 / 60.0)], ny(11, 10, 12)), (day + 10.25 * H, day + 10.75 * H));
        // Today at 14:35: from 14:45, past 14:30–15:30 and a back-to-back 15:30–16:00.
        let now = day + (14.0 + 35.0 / 60.0) * H;
        assert_eq!(next_free_slot(day, end, &[event(14.5, 15.5), event(15.5, 16.0)], now), (day + 16.0 * H, day + 16.5 * H));
        // All-day events don't block; a full day takes its last slot.
        let all_day = CalendarEvent { all_day: true, ..event(0.0, 24.0) };
        assert_eq!(next_free_slot(day, end, &[all_day], ny(11, 10, 12)).0, day + 9.0 * H);
        assert_eq!(next_free_slot(day, end, &[event(0.0, 24.0)], ny(11, 10, 12)), (end - 0.5 * H, end));
    }

    #[test]
    fn reminder_chips_toggle() {
        assert_eq!(toggle_reminder(&None, 10.0), Some(vec![10.0]));
        assert_eq!(toggle_reminder(&Some(vec![30.0]), 10.0), Some(vec![10.0, 30.0]));
        assert_eq!(toggle_reminder(&Some(vec![10.0]), 10.0), Some(vec![]));
    }
}
