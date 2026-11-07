//! The month page (`calendar/month-panel.tsx`): weekday labels over a 6×7 grid of day cells,
//! each with its date and as many event rows as fit, then "+N more". A cell opens its day.

use std::collections::HashMap;

use chrono::{Datelike, Duration, NaiveDate};
use chrono_tz::Tz;
use rune::tok::TextStyle;
use rune::{Cursor, El, col, el, row, text};

use crate::app::State;
use crate::data::colors;
use crate::data::days::start_of_day_ms;
use crate::data::models::CalendarEvent;
use crate::data::page::weekday_short;
use crate::data::week::MS_PER_DAY;
use crate::ui::theme::{self, Paint, fade, mix, rem};

/// `MONTH_EVENT_ROW_HEIGHT` and its gap.
const ROW_H: f32 = 18.0;
const ROW_GAP: f32 = 2.0;
const WEEKDAY: TextStyle = TextStyle::new(11.0, 500.0).tracking(0.275);
const LABEL_ROW_H: f32 = 11.0 * 1.25 + rem(0.5) * 2.0;

/// `visibleMonthEventMetrics`: rows that fit, keeping the last for "+N more" when they don't.
pub fn visible_rows(count: usize, height: f32) -> (usize, usize) {
    let rows = ((height + ROW_GAP) / (ROW_H + ROW_GAP)).floor().max(0.0) as usize;
    let visible = if count <= rows { count } else { rows.saturating_sub(1) };
    (visible, count - visible)
}

/// A cell's events: all-day ones by UTC date (Google's), timed ones by overlap with the
/// day in `zone`; all-day first, then by start.
pub fn events_on<'a>(day: NaiveDate, zone: Tz, events: &'a [CalendarEvent]) -> Vec<&'a CalendarEvent> {
    let start = start_of_day_ms(day, zone);
    let end = start_of_day_ms(day + Duration::days(1), zone);
    let utc = day.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis() as f64;
    let mut on: Vec<&CalendarEvent> = events
        .iter()
        .filter(|e| e.status != "cancelled")
        .filter(|e| if e.all_day { e.start_ms <= utc && utc < e.end_ms.max(e.start_ms + MS_PER_DAY) } else { e.start_ms < end && e.end_ms > start })
        .collect();
    on.sort_by(|a, b| b.all_day.cmp(&a.all_day).then(a.start_ms.total_cmp(&b.start_ms)));
    on
}

pub fn month_view(
    p: &Paint,
    month: NaiveDate,
    days: &[NaiveDate],
    today: NaiveDate,
    zone: Tz,
    events: &[CalendarEvent],
    calendar_colors: &HashMap<String, String>,
    size: [f32; 2],
) -> El {
    let [w, h] = size;
    let cell_w = w / 7.0;
    let cell_h = ((h - LABEL_ROW_H) / 6.0).max(40.0);
    // `p-1`, the `size-6` date, `gap-0.5` before the event area.
    let area_h = cell_h - rem(0.25) * 2.0 - rem(1.5) - rem(0.125);

    let mut labels = row().key("weekday-labels").w_full().h(LABEL_ROW_H).fill(p.calendar_header);
    for day in &days[..7] {
        labels = labels.child(
            row()
                .key(format!("label-{}", day.weekday()))
                .w(cell_w)
                .h_full()
                .px(rem(0.5))
                .center_y()
                .child(text(weekday_short(*day).to_uppercase()).font(WEEKDAY).color(p.muted_foreground)),
        );
    }

    let mut grid = col().key("month-grid").w_full();
    for week in days.chunks(7) {
        let mut week_row = row().key(format!("week-{}", week[0])).w_full().h(cell_h);
        for day in week {
            week_row = week_row.child(cell(p, *day, month, today, zone, events, calendar_colors, cell_w, cell_h, area_h));
        }
        grid = grid.child(week_row);
    }
    col().key("month")
        .w_full()
        .h_full()
        .child(labels)
        .child(el().key("labels-rule").w_full().h(1.0).fill(p.border))
        .child(grid)
}

#[allow(clippy::too_many_arguments)]
fn cell(
    p: &Paint,
    day: NaiveDate,
    month: NaiveDate,
    today: NaiveDate,
    zone: Tz,
    events: &[CalendarEvent],
    calendar_colors: &HashMap<String, String>,
    w: f32,
    h: f32,
    area_h: f32,
) -> El {
    let in_month = day.month() == month.month();
    let is_today = day == today;
    let on = events_on(day, zone, events);
    let (visible, hidden) = visible_rows(on.len(), area_h);

    // `size-6 text-xs font-medium`, a filled circle on today.
    let mut date = row().key("date").size(rem(1.5), rem(1.5)).center().child(
        text(day.day().to_string())
            .font(TextStyle::new(rem(0.75), 500.0))
            .color(if is_today { p.primary_foreground } else if in_month { p.foreground } else { p.muted_foreground }),
    );
    if is_today {
        date = date.radius(rem(0.75)).fill(p.primary);
    }

    let mut area = col().key("events").w_full().gap(ROW_GAP);
    for e in on.iter().take(visible) {
        let hue = theme::event_color(colors::event_swatch(e, calendar_colors));
        area = area.child(
            row()
                .key(format!("chip-{}", e.id))
                .role("button")
                .label(e.title().to_string())
                .on_press({
                    let event = (*e).clone();
                    move |s: &mut State| s.open_event(event.clone())
                })
                .w_full()
                .h(ROW_H)
                .px(rem(0.25))
                .gap(rem(0.25))
                .center_y()
                .radius(rem(0.25))
                .fill(mix(p.card, hue, 0.18))
                .child(el().key("dot").size(rem(0.375), rem(0.375)).radius(rem(0.1875)).fill(hue))
                .child(text(e.title().to_string()).key("title").font(TextStyle::new(11.0, 400.0)).color(p.foreground).truncate().shrink().min_w(0.0)),
        );
    }
    if hidden > 0 {
        area = area.child(
            row()
                .key("more")
                .h(ROW_H)
                .px(rem(0.25))
                .center_y()
                .child(text(format!("+{hidden} more")).font(TextStyle::new(10.0, 400.0)).color(p.muted_foreground)),
        );
    }

    let mut c = col()
        .key(format!("cell-{day}"))
        .role("button")
        .label(format!("{} {}", weekday_short(day), day.day()))
        .w(w)
        .h(h)
        .padding(rem(0.25))
        .gap(rem(0.125))
        .hover(fade(p.accent, 0.5))
        .cursor(Cursor::Pointer)
        .child(date)
        .child(area)
        .child(el().key("rule-left").w(1.0).fill(p.border).pin(Some(0.0), Some(0.0), None, Some(0.0)))
        .child(el().key("rule-bottom").h(1.0).fill(p.border).pin(Some(0.0), None, Some(0.0), Some(0.0)))
        .on_press(move |s: &mut State| s.open_day(day));
    if !in_month {
        c = c.fill(fade(p.muted, 0.3));
    }
    c
}

#[cfg(test)]
mod tests {
    use super::visible_rows;

    #[test]
    fn overflow_keeps_the_last_row_for_the_count() {
        assert_eq!(visible_rows(2, 60.0), (2, 0));
        assert_eq!(visible_rows(5, 60.0), (2, 3), "three rows fit, so two events and +3 more");
        assert_eq!(visible_rows(1, 0.0), (0, 1));
    }
}
