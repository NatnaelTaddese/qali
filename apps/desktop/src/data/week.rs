//! The week grid's arithmetic, ported from `apps/web/src/components/calendar/lib.ts`: which
//! days a week shows in the working zone, which events go to the all-day band and which to each
//! day's column, how overlapping events cascade or tile (`layoutDayEvents`), how all-day events
//! pack into lanes (`layoutAllDayEvents`), and where the now line sits.

use chrono::{Datelike, Duration, NaiveDate};
use chrono_tz::Tz;

use super::days::{start_of_day_ms, today};
use super::models::CalendarEvent;

pub const MS_PER_MINUTE: f64 = 60_000.0;
pub const MS_PER_DAY: f64 = 24.0 * 60.0 * MS_PER_MINUTE;
/// `SNAP_MINUTES`: a timed event is at least this long on the grid.
pub const SNAP_MS: f64 = 15.0 * MS_PER_MINUTE;
/// `LANE_ADVANCE_RATIO`: how far each fanned card steps past the previous one.
pub const LANE_ADVANCE_RATIO: f32 = 0.62;
/// `WEEK_LANE_TILE_MAX_STAGGER_MS`: overlapping starts closer than this tile into columns.
pub const WEEK_TILE_MAX_STAGGER_MS: f64 = 45.0 * MS_PER_MINUTE;
/// `LANE_TILE_MAX_STAGGER_MS`, the day view's counterpart.
pub const DAY_TILE_MAX_STAGGER_MS: f64 = 30.0 * MS_PER_MINUTE;

/// The week's first day, as date-fns numbers it: 0 Sunday, 1 Monday, 6 Saturday.
pub fn week_start(date: NaiveDate, week_starts_on: u32) -> NaiveDate {
    let back = (date.weekday().num_days_from_sunday() + 7 - week_starts_on % 7) % 7;
    date - Duration::days(back as i64)
}

/// The seven days of the week holding `now_ms`, cut in `zone`.
#[cfg(test)]
pub fn week_days(now_ms: f64, zone: Tz, week_starts_on: u32) -> [NaiveDate; 7] {
    let first = week_start(today(now_ms, zone), week_starts_on);
    std::array::from_fn(|i| first + Duration::days(i as i64))
}

/// `[first midnight, midnight after the last day)` in `zone`, the range the week queries.
pub fn range_ms(days: &[NaiveDate], zone: Tz) -> (f64, f64) {
    let last = *days.last().expect("a day");
    (start_of_day_ms(days[0], zone), start_of_day_ms(last + Duration::days(1), zone))
}

/// `bucketDayEvents`: all-day events for the band, timed events per day column (an event that
/// crosses midnight goes to every day it touches). Cancelled events are left out.
pub fn bucket<'a>(days: &[NaiveDate], zone: Tz, events: &'a [CalendarEvent]) -> (Vec<&'a CalendarEvent>, Vec<Vec<&'a CalendarEvent>>) {
    let starts: Vec<f64> = days.iter().map(|d| start_of_day_ms(*d, zone)).collect();
    let (range_start, range_end) = range_ms(days, zone);
    let mut all_day = Vec::new();
    let mut timed: Vec<Vec<&CalendarEvent>> = vec![Vec::new(); days.len()];
    for event in events.iter().filter(|e| e.status != "cancelled") {
        if event.all_day {
            if event.end_ms > range_start && event.start_ms < range_end {
                all_day.push(event);
            }
            continue;
        }
        for (i, day_start) in starts.iter().enumerate() {
            let day_end = starts.get(i + 1).copied().unwrap_or(range_end);
            if *day_start >= event.end_ms.max(event.start_ms + 1.0) {
                break;
            }
            if day_end <= event.start_ms {
                continue;
            }
            timed[i].push(event);
        }
    }
    all_day.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
    (all_day, timed)
}

/// One timed event placed in its day column (`PositionedEvent`).
#[derive(Clone, Debug, PartialEq)]
pub struct Positioned<'a> {
    pub event: &'a CalendarEvent,
    /// 0–1 of the day's height.
    pub top: f32,
    pub height: f32,
    /// Cascade depth: earlier cluster members still running at this event's start.
    pub stack_index: usize,
    /// Paint order within the cluster; later starts sit on top.
    pub elevation: usize,
    pub column_index: usize,
    pub column_count: usize,
    pub column_span: usize,
    /// 1 when the cluster tiles into clean columns, `LANE_ADVANCE_RATIO` when it fans.
    pub lane_advance: f32,
}

impl Positioned<'_> {
    pub fn tiled(&self) -> bool {
        self.lane_advance >= 1.0
    }
}

/// `layoutDayEvents`: clamp to the day (`day_end_ms` is the next midnight, which a DST day
/// moves), then group transitively overlapping events into clusters. Each event indents past
/// the earlier ones still running at its start, packs into first-free lanes for the side-by-side
/// layout, and the whole cluster tiles instead of fanning when two overlapping starts are closer
/// than `tile_max_stagger_ms`.
pub fn layout_day<'a>(events: &[&'a CalendarEvent], day_start_ms: f64, day_end_ms: f64, tile_max_stagger_ms: f64) -> Vec<Positioned<'a>> {
    struct Item<'a> {
        event: &'a CalendarEvent,
        start: f64,
        end: f64,
        stack_index: usize,
        elevation: usize,
        column_index: usize,
        column_count: usize,
        column_span: usize,
        advance: f32,
    }
    let mut items: Vec<Item<'a>> = events
        .iter()
        .map(|event| {
            let start = event.start_ms.max(day_start_ms);
            let end = event.end_ms.max(start + SNAP_MS).min(day_end_ms);
            Item { event, start, end, stack_index: 0, elevation: 0, column_index: 0, column_count: 1, column_span: 1, advance: LANE_ADVANCE_RATIO }
        })
        .collect();
    items.sort_by(|a, b| a.start.total_cmp(&b.start).then((b.end - b.start).total_cmp(&(a.end - a.start))));

    fn close(cluster: &mut [Item<'_>], tile_max_stagger_ms: f64) {
        if cluster.is_empty() {
            return;
        }
        let mut lane_ends: Vec<f64> = Vec::new();
        for item in cluster.iter_mut() {
            let lane = lane_ends.iter().position(|end| *end <= item.start).unwrap_or(lane_ends.len());
            if lane == lane_ends.len() {
                lane_ends.push(item.end);
            } else {
                lane_ends[lane] = item.end;
            }
            item.column_index = lane;
        }
        let count = lane_ends.len();
        let spans: Vec<usize> = cluster
            .iter()
            .map(|item| {
                let mut span = count - item.column_index;
                for other in cluster.iter() {
                    if other.column_index > item.column_index && other.start < item.end && other.end > item.start {
                        span = span.min(other.column_index - item.column_index);
                    }
                }
                span.max(1)
            })
            .collect();
        let mut tiled = false;
        'outer: for i in 0..cluster.len() {
            for j in i + 1..cluster.len() {
                let (a, b) = (&cluster[i], &cluster[j]);
                if a.start < b.end && b.start < a.end && (a.start - b.start).abs() < tile_max_stagger_ms {
                    tiled = true;
                    break 'outer;
                }
            }
        }
        for (item, span) in cluster.iter_mut().zip(spans) {
            item.column_count = count;
            item.column_span = span;
            item.advance = if tiled { 1.0 } else { LANE_ADVANCE_RATIO };
        }
    }

    let mut cluster_start = 0;
    let mut cluster_end = f64::NEG_INFINITY;
    for i in 0..items.len() {
        if items[i].start >= cluster_end {
            close(&mut items[cluster_start..i], tile_max_stagger_ms);
            cluster_start = i;
        }
        let start = items[i].start;
        items[i].stack_index = items[cluster_start..i].iter().filter(|prev| prev.end > start).count();
        items[i].elevation = i - cluster_start;
        cluster_end = cluster_end.max(items[i].end);
    }
    let len = items.len();
    close(&mut items[cluster_start..len], tile_max_stagger_ms);

    let day = (day_end_ms - day_start_ms) as f32;
    items
        .into_iter()
        .map(|it| Positioned {
            event: it.event,
            top: (it.start - day_start_ms) as f32 / day,
            height: (it.end - it.start) as f32 / day,
            stack_index: it.stack_index,
            elevation: it.elevation,
            column_index: it.column_index,
            column_count: it.column_count,
            column_span: it.column_span,
            lane_advance: it.advance,
        })
        .collect()
}

/// `laneBox`: left and width, as 0–1 of the space beside the column's left gutter.
pub fn lane_box(column_index: usize, column_count: usize, column_span: usize, advance: f32) -> (f32, f32) {
    if column_count <= 1 {
        return (0.0, 1.0);
    }
    let width = 1.0 / (1.0 + (column_count - 1) as f32 * advance);
    let step = advance * width;
    (column_index as f32 * step, width + (column_span - 1) as f32 * step)
}

/// `stackIndentPx`: the cascade's left indent, full for three levels, then a thin step.
pub fn stack_indent(stack_index: usize) -> f32 {
    let capped = stack_index.min(3) as f32;
    let overflow = stack_index.saturating_sub(3) as f32;
    capped * 14.0 + overflow * 4.0
}

/// An all-day event's columns and lane (`AllDayEventLayout`).
#[derive(Clone, Debug, PartialEq)]
pub struct AllDay<'a> {
    pub event: &'a CalendarEvent,
    pub start_idx: usize,
    pub end_idx: usize,
    pub lane: usize,
}

/// `allDayColumnSpan` + `layoutAllDayEvents`. All-day bounds are UTC midnights (Google's
/// dates), so columns come from UTC day differences, never the working zone.
pub fn layout_all_day<'a>(days: &[NaiveDate], events: &[&'a CalendarEvent]) -> Vec<AllDay<'a>> {
    let base = days[0].and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis() as f64;
    let last = days.len() as i64 - 1;
    let mut spans: Vec<(i64, i64, &CalendarEvent)> = events
        .iter()
        .map(|e| {
            let start = ((e.start_ms - base) / MS_PER_DAY).round() as i64;
            let end = ((e.end_ms - MS_PER_DAY - base) / MS_PER_DAY).round() as i64;
            (start.max(0), end.max(start).min(last), *e)
        })
        .collect();
    spans.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)).then(a.2.start_ms.total_cmp(&b.2.start_ms)).then(a.2.id.cmp(&b.2.id)));
    let mut lane_ends: Vec<i64> = Vec::new();
    spans
        .into_iter()
        .filter(|(s, e, _)| *e >= 0 && *s <= last)
        .map(|(start, end, event)| {
            let lane = lane_ends.iter().position(|e| *e < start).unwrap_or(lane_ends.len());
            if lane == lane_ends.len() {
                lane_ends.push(end);
            } else {
                lane_ends[lane] = end;
            }
            AllDay { event, start_idx: start as usize, end_idx: end as usize, lane }
        })
        .collect()
}

/// The all-day band shows at most this many lanes until expanded.
pub const ALLDAY_COLLAPSED_LANES: usize = 2;
pub const ALLDAY_MAX_EXPANDED_LANES: usize = 8;
pub const ALLDAY_EVENT_HEIGHT: f32 = 20.0;
pub const ALLDAY_EVENT_GAP: f32 = 4.0;
pub const ALLDAY_BAND_PADDING: f32 = 4.0;

/// `allDayBandHeight`: always room for one lane, so the band never jumps in and out.
pub fn all_day_band_height(lanes: usize, expanded: bool) -> f32 {
    let visible = if expanded { lanes.clamp(1, ALLDAY_MAX_EXPANDED_LANES) } else { lanes.clamp(1, ALLDAY_COLLAPSED_LANES) };
    ALLDAY_BAND_PADDING * 2.0 + visible as f32 * ALLDAY_EVENT_HEIGHT + (visible - 1) as f32 * ALLDAY_EVENT_GAP
}

/// Where the now line goes: 0–1 down today's grid, and today's column if this week has it.
pub fn now_layout(days: &[NaiveDate], now_ms: f64, zone: Tz) -> (f32, Option<usize>) {
    let date = today(now_ms, zone);
    let start = start_of_day_ms(date, zone);
    let end = start_of_day_ms(date + Duration::days(1), zone);
    (((now_ms - start) / (end - start)) as f32, days.iter().position(|d| *d == date))
}

#[cfg(test)]
#[path = "week_tests.rs"]
mod tests;
