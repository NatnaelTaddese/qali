//! A timed event's card in a day column, after `calendar/event-card.tsx` and the
//! `.event-card` size steps in globals.css: two title lines and the time when there's room,
//! one line under 52pt, and a single small centred title under 38pt.

use chrono_tz::Tz;
use rune::tok::TextStyle;
use rune::{El, col, row, text};

use super::{DAY_H, EVENT_LEFT_GUTTER, clock};
use crate::data::colors::Swatch;
use crate::data::week::{Positioned, lane_box, stack_indent};
use crate::ui::components::{Elevation, EventCard};
use crate::ui::theme::{self, Paint, rem};

/// `min-h-[20px]`: short events draw a little taller than they last so the title reads.
const MIN_H: f32 = 20.0;

/// Where a card sits in its column of width `col_w`: `(left, width)` in points.
pub fn horizontal(p: &Positioned<'_>, col_w: f32, lanes: bool) -> (f32, f32) {
    let avail = (col_w - EVENT_LEFT_GUTTER).max(0.0);
    if lanes || p.tiled() {
        let (left, width) = lane_box(p.column_index, p.column_count, p.column_span, p.lane_advance);
        (EVENT_LEFT_GUTTER + left * avail + 2.0, (width * avail - 4.0).max(0.0))
    } else {
        let indent = stack_indent(p.stack_index);
        (EVENT_LEFT_GUTTER + indent + 2.0, (avail - indent - 4.0).max(0.0))
    }
}

/// `lanes` fans overlaps side by side (the day view's wide column) instead of cascading them.
pub fn event_block(paint: &Paint, p: &Positioned<'_>, swatch: Swatch, col_w: f32, lanes: bool, zone: Tz, use_24h: bool) -> El {
    let e = p.event;
    let (left, width) = horizontal(p, col_w, lanes);
    let height = (p.height * DAY_H).max(MIN_H);
    let tiny = height <= 38.0;
    let title_style = if tiny { TextStyle::new(rem(0.75), 500.0) } else { theme::TEXT_SM_MEDIUM };
    let title = text(e.title().to_string())
        .key("title")
        .font(title_style)
        .color(paint.foreground)
        .max_lines(if height <= 52.0 { 1 } else { 2 });

    // `py-1 pr-2 pl-3`; the tiny step drops the vertical padding and centres its one line
    // vertically, still flush left.
    if tiny {
        let body = row().key("body").w_full().h_full().pr(rem(0.5)).pl(rem(0.75)).center_y().child(title.shrink().min_w(0.0));
        return card(paint, p, swatch, body, left, width, height);
    }
    let mut body = col().key("body").w_full().h_full().pr(rem(0.5)).pl(rem(0.75)).child(title);
    {
        let when = format!("{} – {}", clock(e.start_ms, zone, use_24h, false), clock(e.end_ms, zone, use_24h, true));
        body = body
            .pt(rem(0.25))
            .pb(rem(0.25))
            .child(text(when).key("time").font(theme::TEXT_XS).color(paint.muted_foreground).truncate());
    }

    card(paint, p, swatch, body, left, width, height)
}

fn card(paint: &Paint, p: &Positioned<'_>, swatch: Swatch, body: El, left: f32, width: f32, height: f32) -> El {
    let e = p.event;
    EventCard::new(format!("event-{}", e.id), theme::event_color(swatch))
        .radius(theme::RADIUS_LG)
        .pill_inset(rem(0.25))
        .elevation(Elevation::Sm)
        .build(paint, body)
        .role("button")
        .label(e.title().to_string())
        .cursor(rune::Cursor::Pointer)
        .press_scale(0.97)
        .on_press({
            let event = e.clone();
            move |s: &mut crate::app::State| s.open_event(event.clone())
        })
        .w(width)
        .h(height)
        .absolute(left, p.top * DAY_H)
}
