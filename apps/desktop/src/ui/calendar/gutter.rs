//! The hour column pinned left of the days (`gutter-column.tsx`, `time-gutter.tsx`): the
//! zone's short name over the hours, the hour labels, and the red pill with the current time.

use rune::tok::TextStyle;
use rune::{El, col, el, row, text};

use super::{DAY_H, GUTTER_W, HOUR_H};
use crate::ui::theme::{Paint, rem};

/// `text-[10px]` (pixels, not rem).
const LABEL: TextStyle = TextStyle::new(10.0, 400.0);

/// "9am", "12pm", or "13" on a 24-hour clock, as `Intl` prints `hour: "numeric"`.
pub fn hour_label(hour: u32, use_24h: bool) -> String {
    if use_24h {
        return format!("{hour:02}");
    }
    let h12 = if hour % 12 == 0 { 12 } else { hour % 12 };
    format!("{h12}{}", if hour < 12 { "am" } else { "pm" })
}

/// The block above the hours: the zone label, and "+N" when all-day lanes are hidden.
pub fn gutter_header(p: &Paint, zone_label: &str, height: f32, hidden_all_day: usize, expanded: bool) -> El {
    let mut header = el()
        .key("gutter-header")
        .w(GUTTER_W)
        .h(height)
        .fill(p.calendar_header)
        .child(
            text(zone_label.to_string())
                .key("zone")
                .font(LABEL)
                .color(p.muted_foreground)
                .truncate()
                .pin(Some(rem(0.375)), Some(rem(0.5)), Some(rem(0.375)), None),
        )
        .child(el().key("rule").h(1.0).fill(p.border).pin(Some(0.0), None, Some(0.0), Some(0.0)));
    if hidden_all_day > 0 || expanded {
        let label = if expanded { "Less".to_string() } else { format!("+{hidden_all_day}") };
        header = header.child(
            row()
                .key("all-day-toggle")
                .role("button")
                .label(if expanded { "Collapse all-day events".to_string() } else { format!("Show {hidden_all_day} more all-day events") })
                .focusable(true)
                .h(20.0)
                .px(rem(0.25))
                .center()
                .radius(6.75)
                .fill(p.accent)
                .border(1.0, p.border)
                .cursor(rune::Cursor::Pointer)
                .child(text(label).font(TextStyle::new(10.0, 500.0)).color(p.muted_foreground))
                .pin(None, None, Some(4.0), Some(4.0))
                .on_press(|s: &mut crate::app::State| s.all_day_expanded = !s.all_day_expanded),
        );
    }
    header
}

/// The hours themselves, with the now pill when `now` (0–1 down the day) is given.
pub fn gutter_body(p: &Paint, use_24h: bool, now: Option<(f32, String)>) -> El {
    let mut body = el().key("gutter-body").w(GUTTER_W).h(DAY_H);
    for hour in 1..24 {
        body = body.child(
            row()
                .key(format!("hour-{hour}"))
                .h(12.0)
                .child(text(hour_label(hour, use_24h)).font(LABEL.features("'tnum' 1")).color(p.muted_foreground))
                .pin(None, Some(hour as f32 * HOUR_H - 6.0), Some(rem(0.375)), None),
        );
    }
    if let Some((top, label)) = now {
        let red = p.now;
        // `rounded-full bg-red-500 px-1.5 py-0.5 text-xs font-semibold`, centred on the line,
        // with a short stub reaching to the grid.
        let pill = row()
            .key("now-pill")
            .h(rem(0.75) + rem(0.25))
            .px(rem(0.375))
            .center()
            .radius(999.0)
            .fill(red)
            .shadow(1.0, 2.0, crate::ui::theme::black(0.12))
            .child(text(label).font(TextStyle::new(rem(0.75), 600.0).features("'tnum' 1")).color(rune::Color::WHITE));
        let pill_h = rem(0.75) + rem(0.25);
        body = body.child(
            row()
                .key("now-marker")
                .center_y()
                .child(pill)
                .child(el().key("stub").w(6.0).h(2.0).fill(red))
                .pin(None, Some(top * DAY_H - pill_h / 2.0), Some(rem(0.375) - 6.0), None),
        );
    }
    col().key("gutter").w(GUTTER_W).child(body)
}

#[cfg(test)]
mod tests {
    use super::hour_label;

    #[test]
    fn hour_labels_read_like_intl() {
        assert_eq!(hour_label(9, false), "9am");
        assert_eq!(hour_label(12, false), "12pm");
        assert_eq!(hour_label(23, false), "11pm");
        assert_eq!(hour_label(9, true), "09");
    }
}
