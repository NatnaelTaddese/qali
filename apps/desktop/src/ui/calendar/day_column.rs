//! One day of the grid (`calendar/day-column.tsx`): a left divider, today's faint tint that
//! fades out toward the bottom, and its event cards in paint order.

use std::collections::HashMap;

use chrono_tz::Tz;
use rune::{El, el};

use super::DAY_H;
use super::event_block::event_block;
use crate::data::colors;
use crate::data::week::Positioned;
use crate::ui::theme::{Paint, fade};

pub fn day_column(
    p: &Paint,
    key: String,
    positioned: &[Positioned<'_>],
    calendar_colors: &HashMap<String, String>,
    col_w: f32,
    is_today: bool,
    lanes: bool,
    zone: Tz,
    use_24h: bool,
) -> El {
    let mut column = el().key(key).w(col_w).h(DAY_H).child(el().key("divider").w(1.0).fill(p.border).pin(Some(0.0), Some(0.0), None, Some(0.0)));
    if is_today {
        // `color-mix(in oklab, var(--primary) 3%, transparent)` down to 75%, then fading out.
        let tint = fade(p.primary, 0.03);
        column = column.child(
            el().key("today-tint")
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .linear_gradient(std::f32::consts::PI, [(0.0, tint), (0.75, tint), (1.0, tint.alpha(0.0))]),
        );
    }
    // `layout_day` returns cards in start order, which is the paint order: within a cluster a
    // later start (higher `elevation`) sits on top of the earlier cards it overlaps.
    for card in positioned {
        let swatch = colors::event_swatch(card.event, calendar_colors);
        column = column.child(event_block(p, card, swatch, col_w, lanes, zone, use_24h));
    }
    column
}
