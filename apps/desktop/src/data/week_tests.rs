use chrono::{NaiveDate, TimeZone};
use chrono_tz::Tz;

use super::*;

const NY: Tz = chrono_tz::America::New_York;

fn ms(y: i32, m: u32, d: u32, h: u32, min: u32) -> f64 {
    NY.with_ymd_and_hms(y, m, d, h, min, 0).unwrap().timestamp_millis() as f64
}

fn utc(y: i32, m: u32, d: u32) -> f64 {
    chrono::Utc.with_ymd_and_hms(y, m, d, 0, 0, 0).unwrap().timestamp_millis() as f64
}

fn ev(id: &str, start_ms: f64, end_ms: f64) -> CalendarEvent {
    CalendarEvent { id: id.into(), start_ms, end_ms, summary: Some(id.into()), status: "confirmed".into(), ..Default::default() }
}

fn all_day(id: &str, start_ms: f64, end_ms: f64) -> CalendarEvent {
    CalendarEvent { all_day: true, ..ev(id, start_ms, end_ms) }
}

fn date(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

#[test]
fn weeks_start_on_the_preferred_day() {
    let wed = date(2026, 11, 11);
    assert_eq!(week_start(wed, 1), date(2026, 11, 9), "Monday");
    assert_eq!(week_start(wed, 0), date(2026, 11, 8), "Sunday");
    assert_eq!(week_start(wed, 6), date(2026, 11, 7), "Saturday");
    assert_eq!(week_start(date(2026, 11, 9), 1), date(2026, 11, 9), "a Monday is its own start");
}

#[test]
fn the_fall_back_week_is_one_hour_longer() {
    let days = week_days(ms(2026, 11, 1, 12, 0), NY, 1);
    assert_eq!(days[0], date(2026, 10, 26));
    let (start, end) = range_ms(&days, NY);
    assert_eq!(end - start, 7.0 * MS_PER_DAY + 3_600_000.0);
}

#[test]
fn bucketing_splits_all_day_and_spreads_overnight_events() {
    let days = week_days(ms(2026, 11, 11, 9, 0), NY, 1);
    let mut cancelled = ev("gone", ms(2026, 11, 9, 9, 0), ms(2026, 11, 9, 10, 0));
    cancelled.status = "cancelled".into();
    let events = vec![
        ev("late", ms(2026, 11, 10, 22, 0), ms(2026, 11, 11, 2, 0)),
        all_day("offsite", utc(2026, 11, 12), utc(2026, 11, 14)),
        ev("next-week", ms(2026, 11, 16, 9, 0), ms(2026, 11, 16, 10, 0)),
        cancelled,
    ];
    let (band, timed) = bucket(&days, NY, &events);
    assert_eq!(band.len(), 1);
    assert_eq!(timed[1].len(), 1, "Tuesday");
    assert_eq!(timed[2].len(), 1, "and Wednesday");
    assert!(timed.iter().enumerate().all(|(i, t)| i == 1 || i == 2 || t.is_empty()));
}

#[test]
fn a_cluster_with_close_starts_tiles_and_a_staggered_one_cascades() {
    let day = ms(2026, 11, 11, 0, 0);
    let next = ms(2026, 11, 12, 0, 0);
    // 3:00 and 3:30 start within 45 minutes: tiled into two columns.
    let a = ev("review", ms(2026, 11, 11, 15, 0), ms(2026, 11, 11, 16, 0));
    let b = ev("hiring", ms(2026, 11, 11, 15, 30), ms(2026, 11, 11, 16, 30));
    let tiled = layout_day(&[&a, &b], day, next, WEEK_TILE_MAX_STAGGER_MS);
    assert!(tiled.iter().all(|p| p.tiled() && p.column_count == 2));
    assert_eq!((tiled[0].column_index, tiled[1].column_index), (0, 1));
    assert_eq!(tiled[1].stack_index, 1);

    // 10:00–12:00 and 11:00–11:30 start an hour apart: the later one cascades on top.
    let c = ev("deep", ms(2026, 11, 11, 10, 0), ms(2026, 11, 11, 12, 0));
    let d = ev("call", ms(2026, 11, 11, 11, 0), ms(2026, 11, 11, 11, 30));
    let cascade = layout_day(&[&d, &c], day, next, WEEK_TILE_MAX_STAGGER_MS);
    assert_eq!(cascade[0].event.id, "deep", "sorted by start");
    assert!(!cascade[1].tiled());
    assert_eq!((cascade[1].stack_index, cascade[1].elevation), (1, 1));
    assert!((cascade[0].top - 10.0 / 24.0).abs() < 1e-6);
    assert!((cascade[0].height - 2.0 / 24.0).abs() < 1e-6);
}

#[test]
fn short_events_get_the_snap_height_and_overnight_ones_clamp_to_the_day() {
    let day = ms(2026, 11, 11, 0, 0);
    let next = ms(2026, 11, 12, 0, 0);
    let instant = ev("ping", ms(2026, 11, 11, 9, 0), ms(2026, 11, 11, 9, 0));
    let late = ev("late", ms(2026, 11, 11, 23, 0), ms(2026, 11, 12, 2, 0));
    let out = layout_day(&[&instant, &late], day, next, WEEK_TILE_MAX_STAGGER_MS);
    assert!((out[0].height - 15.0 / (24.0 * 60.0)).abs() < 1e-6);
    assert!((out[1].top + out[1].height - 1.0).abs() < 1e-6);
}

#[test]
fn lane_boxes_fan_to_the_right_edge_and_tile_evenly() {
    let (l0, w0) = lane_box(0, 2, 1, LANE_ADVANCE_RATIO);
    let (l1, w1) = lane_box(1, 2, 1, LANE_ADVANCE_RATIO);
    assert_eq!(l0, 0.0);
    assert!((l1 + w1 - 1.0).abs() < 1e-6, "the last card ends flush");
    assert!(l1 < w0, "fanned cards overlap");
    assert_eq!(lane_box(1, 2, 1, 1.0), (0.5, 0.5));
    assert_eq!(stack_indent(0), 0.0);
    assert_eq!(stack_indent(5), 3.0 * 14.0 + 2.0 * 4.0);
}

#[test]
fn all_day_events_pack_into_lanes_by_utc_date() {
    let days = week_days(ms(2026, 11, 11, 9, 0), NY, 1);
    let trip = all_day("trip", utc(2026, 11, 8), utc(2026, 11, 11));
    let offsite = all_day("offsite", utc(2026, 11, 10), utc(2026, 11, 12));
    let holiday = all_day("holiday", utc(2026, 11, 11), utc(2026, 11, 12));
    let out = layout_all_day(&days, &[&trip, &offsite, &holiday]);
    let by = |id: &str| out.iter().find(|a| a.event.id == id).unwrap();
    assert_eq!((by("trip").start_idx, by("trip").end_idx, by("trip").lane), (0, 1, 0), "clamped to Monday");
    assert_eq!((by("offsite").start_idx, by("offsite").end_idx, by("offsite").lane), (1, 2, 1));
    assert_eq!(by("holiday").lane, 0, "reuses the lane trip left on Wednesday");
    assert_eq!(all_day_band_height(0, false), 28.0);
    assert_eq!(all_day_band_height(5, false), 52.0);
}

#[test]
fn the_now_line_finds_today() {
    let days = week_days(ms(2026, 11, 11, 15, 0), NY, 1);
    let (top, col) = now_layout(&days, ms(2026, 11, 11, 15, 0), NY);
    assert_eq!(col, Some(2));
    assert!((top - 15.0 / 24.0).abs() < 1e-6);
}
