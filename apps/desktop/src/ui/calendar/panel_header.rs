//! The weekday/date row and the all-day band above the grid (`calendar/panel-header.tsx`).

use std::collections::HashMap;

use chrono::{Datelike, NaiveDate};
use rune::tok::TextStyle;
use rune::{El, col, el, row, text};

use super::HEADER_DATE_H;
use crate::data::page::weekday_short;
use crate::data::colors;
use crate::data::week::{ALLDAY_BAND_PADDING, ALLDAY_COLLAPSED_LANES, ALLDAY_EVENT_GAP, ALLDAY_EVENT_HEIGHT, AllDay};
use crate::ui::components::{Elevation, EventCard};
use crate::ui::theme::{self, Paint, rem};

/// `text-[11px] font-medium tracking-wide uppercase`.
const WEEKDAY: TextStyle = TextStyle::new(11.0, 500.0).tracking(0.275);
/// `text-lg font-semibold`.
const DATE: TextStyle = TextStyle::new(rem(1.125), 600.0);

pub fn panel_header(
    p: &Paint,
    days: &[NaiveDate],
    today: Option<usize>,
    all_day: &[AllDay<'_>],
    all_day_h: f32,
    expanded: bool,
    calendar_colors: &HashMap<String, String>,
    col_w: f32,
) -> El {
    let mut dates = row().key("dates").h(HEADER_DATE_H);
    let mut dividers = el().key("dividers").pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0));
    for (i, day) in days.iter().enumerate() {
        let is_today = today == Some(i);
        let weekday = weekday_short(*day).to_uppercase();
        let date: El = if is_today {
            // `size-7 rounded-full bg-primary`, the date centred in it.
            row()
                .key("today-dot")
                .size(rem(1.75), rem(1.75))
                .center()
                .radius(rem(0.875))
                .fill(p.primary)
                .child(text(day.day().to_string()).font(DATE).color(p.primary_foreground))
        } else {
            text(day.day().to_string()).key("date").font(DATE).color(p.foreground)
        };
        dates = dates.child(
            row()
                .key(format!("date-{day}"))
                .w(col_w)
                .h_full()
                .px(rem(0.5))
                .gap(rem(0.375))
                .center_y()
                .child(text(weekday).key("weekday").font(WEEKDAY).color(if is_today { p.foreground } else { p.muted_foreground }))
                .child(date),
        );
        // Dividers fade in from the top over the first 32pt, through both rows.
        let height = HEADER_DATE_H + 200.0;
        dividers = dividers.child(
            el().key(format!("divider-{i}"))
                .w(1.0)
                .pin(Some(i as f32 * col_w), Some(0.0), None, Some(0.0))
                .linear_gradient(std::f32::consts::PI, [(0.0, p.border.alpha(0.0)), (32.0 / height, p.border), (1.0, p.border)]),
        );
    }

    let mut band = el().key("all-day").w_full().h(all_day_h);
    for a in all_day {
        if !expanded && a.lane >= ALLDAY_COLLAPSED_LANES {
            continue;
        }
        let swatch = colors::event_swatch(a.event, calendar_colors);
        let span = (a.end_idx - a.start_idx + 1) as f32;
        let label = text(a.event.title().to_string()).key("title").font(TextStyle::new(rem(0.75), 500.0)).color(p.foreground).truncate();
        let content = row().key("body").w_full().h_full().pl(rem(0.625)).pr(rem(0.5)).center_y().child(label);
        band = band.child(
            EventCard::new(format!("all-day-{}", a.event.id), theme::event_color(swatch))
                .radius(theme::RADIUS - 2.0)
                .pill_inset(rem(0.25))
                .elevation(Elevation::None)
                .build(p, content)
                .role("button")
                .label(a.event.title().to_string())
                .cursor(rune::Cursor::Pointer)
                .press_scale(0.97)
                .on_press({
                    let event = a.event.clone();
                    move |s: &mut crate::app::State| s.open_event(event.clone())
                })
                .w(col_w * span - 8.0)
                .h(ALLDAY_EVENT_HEIGHT)
                .absolute(col_w * a.start_idx as f32 + 4.0, ALLDAY_BAND_PADDING + a.lane as f32 * (ALLDAY_EVENT_HEIGHT + ALLDAY_EVENT_GAP)),
        );
    }

    el().key("panel-header")
        .w_full()
        .h(HEADER_DATE_H + all_day_h)
        .fill(p.calendar_header)
        .child(dividers)
        .child(col().key("rows").w_full().child(dates).child(band))
        .child(el().key("rule").h(1.0).fill(p.border).pin(Some(0.0), None, Some(0.0), Some(0.0)))
}
