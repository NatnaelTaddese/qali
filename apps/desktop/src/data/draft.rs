//! The form's time and reminder controls (`calendar/event-form.tsx`), as pure steps over
//! `[start, end)`. Times split into the hour, minute and AM/PM wheels and back in the working
//! zone; a picked day moves the start or end onto it. A later start drags the end along; the
//! end may land before the start, which the form flags. All-day events are whole UTC days
//! (Google's all-day bounds), the end exclusive.

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;

use super::days::start_of_day_ms;
use super::models::CalendarEvent;
use super::week::{MS_PER_DAY, SNAP_MS};

/// Reminder presets in minutes before (`REMINDER_PRESETS` on the web).
pub const TIMED_REMINDERS: [f64; 5] = [5.0, 10.0, 30.0, 60.0, 1440.0];
/// The day before at 9:00, and the week before at 9:00.
pub const ALL_DAY_REMINDERS: [f64; 2] = [900.0, 9540.0];


fn utc_date(ms: f64) -> NaiveDate {
    DateTime::<Utc>::from_timestamp_millis(ms as i64).unwrap_or_default().date_naive()
}

fn utc_midnight(date: NaiveDate) -> f64 {
    date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis() as f64
}





/// Minutes between the minute wheel's rows.
pub const MINUTE_STEP: u32 = 5;
pub const MERIDIEM: [&str; 2] = ["AM", "PM"];

/// The hour wheel's rows: 1–12, or 00–23 on a 24-hour clock.
pub fn hour_labels(use_24h: bool) -> Vec<String> {
    if use_24h { (0..24).map(|h| format!("{h:02}")).collect() } else { (1..=12).map(|h| h.to_string()).collect() }
}

pub fn minute_labels() -> Vec<String> {
    (0..60 / MINUTE_STEP).map(|i| format!("{:02}", i * MINUTE_STEP)).collect()
}

fn local(ms: f64, zone: Tz) -> DateTime<Tz> {
    zone.timestamp_millis_opt(ms as i64).earliest().unwrap_or_else(|| zone.timestamp_millis_opt(0).unwrap())
}

/// The wheels' rows for `ms` in `zone`: hour, minute (rounded onto the wheel's step), AM/PM.
pub fn parts_of(ms: f64, use_24h: bool, zone: Tz) -> [usize; 3] {
    use chrono::Timelike;
    let t = local(ms, zone);
    let minute = (((t.minute() as f32 / MINUTE_STEP as f32).round() as u32) * MINUTE_STEP).min(60 - MINUTE_STEP);
    let hour = t.hour() as usize;
    let hour_row = if use_24h { hour } else { (if hour % 12 == 0 { 12 } else { hour % 12 }) - 1 };
    [hour_row, (minute / MINUTE_STEP) as usize, usize::from(hour >= 12)]
}

/// `base`'s calendar day in `zone` at `hour:minute`; a time a DST gap skips moves past it.
fn at_time(base: f64, hour: u32, minute: u32, zone: Tz) -> f64 {
    let day = local(base, zone).date_naive();
    let mut t = day.and_hms_opt(hour, minute, 0).unwrap();
    loop {
        if let Some(found) = zone.from_local_datetime(&t).earliest() {
            return found.timestamp_millis() as f64;
        }
        t += chrono::Duration::minutes(15);
    }
}

/// The time the wheels show, on `base`'s calendar day (`withParts`).
pub fn with_parts(base: f64, parts: [usize; 3], use_24h: bool, zone: Tz) -> f64 {
    let hour = if use_24h { parts[0] as u32 } else { (parts[0] as u32 + 1) % 12 + if parts[2] == 1 { 12 } else { 0 } };
    at_time(base, hour, parts[1] as u32 * MINUTE_STEP, zone)
}

/// A wheel turned: the start drags the end along so a later start keeps a span; the end is
/// set as it is, even before the start (`setPart`).
pub fn set_time(start: f64, end: f64, editing_end: bool, next: f64) -> (f64, f64) {
    if editing_end { (start, next) } else { (next, end.max(next + SNAP_MS)) }
}

/// The calendar day the start or end shows: a timed event's in `zone`; an all-day event's
/// UTC day, its end as the last day it covers.
pub fn day_of(start: f64, end: f64, editing_end: bool, all_day: bool, zone: Tz) -> NaiveDate {
    match (all_day, editing_end) {
        (true, false) => utc_date(start),
        (true, true) => utc_date(last_day_ms(start, end)),
        (false, false) => local(start, zone).date_naive(),
        (false, true) => local(end, zone).date_naive(),
    }
}

/// A day picked for the start or end (`setDay`). A timed side keeps its time of day; the start
/// drags the end along; the end never lands before the start. An all-day start moves the
/// whole span; an all-day end is the last day covered.
pub fn set_day(start: f64, end: f64, editing_end: bool, all_day: bool, day: NaiveDate, zone: Tz) -> (f64, f64) {
    use chrono::Timelike;
    if all_day {
        let d = utc_midnight(day);
        return if editing_end { (start, (d + MS_PER_DAY).max(start + MS_PER_DAY)) } else { (d, d + (end - start).max(MS_PER_DAY)) };
    }
    let side = if editing_end { end } else { start };
    let t = local(side, zone);
    let moved = at_time(start_of_day_ms(day, zone), t.hour(), t.minute(), zone);
    if editing_end { (start, moved.max(start + SNAP_MS)) } else { (moved, end.max(moved + SNAP_MS)) }
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
    fn times_split_into_wheels_and_back() {
        let t = ny(11, 11, 15) + 7.0 * 60_000.0;
        assert_eq!(parts_of(t, false, NY), [2, 1, 1], "3:07 PM reads 3 · 05 · PM");
        assert_eq!(parts_of(t, true, NY), [15, 1, 1], "the AM/PM row is kept, just not shown");
        assert_eq!(parts_of(ny(11, 11, 0), false, NY), [11, 0, 0], "midnight is 12 AM");
        assert_eq!(with_parts(t, [11, 6, 1], false, NY), ny(11, 11, 12) + 30.0 * 60_000.0, "12:30 PM");
        assert_eq!(with_parts(t, [9, 0, 0], true, NY), ny(11, 11, 9));
        assert_eq!(hour_labels(false).len(), 12);
        assert_eq!(minute_labels()[11], "55");
    }

    #[test]
    fn a_later_start_drags_the_end_but_the_end_is_set_as_is() {
        assert_eq!(set_time(10.0 * H, 11.0 * H, false, 10.5 * H), (10.5 * H, 11.0 * H));
        assert_eq!(set_time(10.0 * H, 11.0 * H, false, 12.0 * H), (12.0 * H, 12.25 * H));
        assert_eq!(set_time(10.0 * H, 11.0 * H, true, 9.0 * H), (10.0 * H, 9.0 * H), "flagged, not fixed");
    }

    #[test]
    fn picked_days_keep_the_time_across_dst() {
        let day = |d: u32| NaiveDate::from_ymd_opt(2026, if d > 20 { 10 } else { 11 }, d).unwrap();
        // Sat 31 Oct 10:00 EDT → Sun 1 Nov 10:00 EST, the end dragged along.
        assert_eq!(set_day(ny(10, 31, 10), ny(10, 31, 11), false, false, day(1), NY), (ny(11, 1, 10), ny(11, 1, 10) + SNAP_MS));
        assert_eq!(set_day(ny(10, 31, 10), ny(10, 31, 11), true, false, day(2), NY), (ny(10, 31, 10), ny(11, 2, 11)));
        assert_eq!(set_day(ny(10, 31, 10), ny(10, 31, 11), true, false, day(30), NY).1, ny(10, 31, 10) + SNAP_MS, "never before the start");
        assert_eq!(day_of(ny(10, 31, 10), ny(11, 2, 11), true, false, NY), day(2));
        let utc = |d: u32| Utc.with_ymd_and_hms(2026, 11, d, 0, 0, 0).unwrap().timestamp_millis() as f64;
        assert_eq!(set_day(utc(11), utc(13), false, true, day(14), NY), (utc(14), utc(16)), "an all-day start moves the span");
        assert_eq!(set_day(utc(11), utc(13), true, true, day(15), NY), (utc(11), utc(16)), "the end is the last day covered");
        assert_eq!(day_of(utc(11), utc(13), true, true, NY), day(12));
    }

    #[test]
    fn all_day_round_trips() {
        let utc = |d: u32| Utc.with_ymd_and_hms(2026, 11, d, 0, 0, 0).unwrap().timestamp_millis() as f64;
        // 11 PM to 1 AM touches two days; a meeting ending at midnight only one.
        assert_eq!(to_all_day(ny(11, 11, 23), ny(11, 12, 1), NY), (utc(11), utc(13)));
        assert_eq!(to_all_day(ny(11, 11, 15), ny(11, 12, 0), NY), (utc(11), utc(12)));
        assert_eq!(to_timed(utc(11), NY), (ny(11, 11, 9), ny(11, 11, 10)));
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
