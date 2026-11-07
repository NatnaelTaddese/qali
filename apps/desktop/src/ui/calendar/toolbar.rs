//! The toolbar in the titlebar band (direction C), after the web calendar's header: the page's
//! title (and week number) on the left; the Day / Week / Month switch, Today and the arrows on
//! the right. Your account lives in the island.

use rune::tok::TextStyle;
use rune::{Cursor, El, icon, row, text};

use super::iso_week;
use crate::app::State;
use crate::data::page::{self, View};
use crate::ui::components::icons::{ARROW_LEFT_01, ARROW_RIGHT_01};
use crate::ui::components::segmented;
use crate::ui::theme::{Paint, rem};

pub const HEIGHT: f32 = 52.0;

pub fn toolbar(s: &State, p: &Paint, leading: f32) -> El {
    let start = s.page_start();
    let mut title = row()
        .key("title")
        .gap(rem(0.5))
        .center_y()
        .child(text(page::title(s.view, start)).key("title-text").font(TextStyle::new(rem(0.875), 500.0)).color(p.foreground));
    if s.view == View::Week {
        // `rounded-md bg-secondary px-2 py-0.5 text-xs font-medium`.
        title = title.child(
            row()
                .key("week-chip")
                .px(rem(0.5))
                .py(rem(0.125))
                .radius(6.75)
                .fill(p.secondary)
                .child(text(format!("W{}", iso_week(start))).font(TextStyle::new(rem(0.75), 500.0)).color(p.secondary_foreground)),
        );
    }

    let views: Vec<(&str, &str)> = View::ALL.iter().map(|v| (v.label(), v.label())).collect();
    let selected = View::ALL.iter().position(|v| *v == s.view).unwrap_or(1);
    let switch = segmented::<State>(p, "view-switch", &views, selected, |i| Box::new(move |s: &mut State| s.set_view(View::ALL[i])));

    // `rounded-md px-2.5 py-1 text-sm font-medium hover:bg-accent`.
    let today = row()
        .key("today")
        .role("button")
        .label("Today")
        .focusable(true)
        .px(rem(0.625))
        .py(rem(0.25))
        .radius(6.75)
        .hover(p.accent)
        .cursor(Cursor::Pointer)
        .child(text("Today").font(crate::ui::theme::TEXT_SM_MEDIUM).color(p.foreground))
        .on_press(|s: &mut State| s.go_today());
    let nav = row()
        .key("nav")
        .gap(rem(0.25))
        .center_y()
        .child(today)
        .child(arrow(p, "previous", "Previous", true).on_press(|s: &mut State| s.step(-1)))
        .child(arrow(p, "next", "Next", false).on_press(|s: &mut State| s.step(1)));

    row()
        .key("toolbar")
        .w_full()
        .h(HEIGHT)
        .pl(leading)
        .pr(rem(1.0))
        .gap(rem(1.0))
        .center_y()
        .fill(p.calendar_header)
        .window_drag()
        .child(title.grow(1.0).min_w(0.0))
        .child(row().key("controls").gap(rem(0.75)).center_y().child(switch).child(nav))
}

/// `NavArrow`: `size-7 rounded-md text-muted-foreground hover:bg-accent`.
fn arrow(p: &Paint, key: &str, label: &str, left: bool) -> El {
    row()
        .key(key.to_string())
        .role("button")
        .label(label.to_string())
        .focusable(true)
        .size(rem(1.75), rem(1.75))
        .center()
        .radius(6.75)
        .hover(p.accent)
        .cursor(Cursor::Pointer)
        .child(icon(if left { &ARROW_LEFT_01 } else { &ARROW_RIGHT_01 }, rem(1.0)).color(p.muted_foreground))
}
