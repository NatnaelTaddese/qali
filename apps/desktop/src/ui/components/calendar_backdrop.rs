//! `CalendarBackdrop`, after `apps/web/src/components/booking/calendar-backdrop.tsx`: the faint
//! calendar time grid behind the account-less screens, so they preview the calendar they lead
//! into. Hour rows run from the top, day columns are anchored to the window's centre, the grid
//! fades toward the edges, and a few ghost events sit on it from the `sm` width up.
//!
//! The web fades the lines with a radial `mask-image`; on a solid background that is the same
//! as a background-coloured radial gradient laid over the lines, which is what this draws.

use rune::{El, el, text};

use super::event_card::EventCard;
use crate::ui::theme::{self, Paint, fade};

/// One "day" column and one "hour" row, in points (the web's px, not rem).
const COL: f32 = 200.0;
const ROW: f32 = 64.0;
/// Inset that keeps a ghost inside its cell rather than on the lines.
const CELL_GAP: f32 = 4.0;
/// Tailwind's `sm` breakpoint: narrower than this, the ghosts don't fit beside the card.
const SM: f32 = 640.0;

struct Ghost {
    event: usize,
    title: &'static str,
    time: &'static str,
    col: f32,
    row: f32,
    row_span: f32,
}

const GHOSTS: [Ghost; 5] = [
    Ghost { event: 4, title: "Standup", time: "9:00 – 9:15 AM", col: -3.0, row: 1.0, row_span: 1.0 },
    Ghost { event: 6, title: "Deep work", time: "10:00 – 12:00 PM", col: -4.0, row: 5.0, row_span: 2.0 },
    Ghost { event: 5, title: "1:1", time: "4:00 – 4:30 PM", col: -3.0, row: 10.0, row_span: 1.0 },
    Ghost { event: 8, title: "Lunch", time: "12:30 – 1:30 PM", col: 3.0, row: 2.0, row_span: 1.0 },
    Ghost { event: 2, title: "Design review", time: "2:00 – 3:00 PM", col: 3.0, row: 7.0, row_span: 2.0 },
];

/// A full-window, non-interactive layer of `size` (the window's points). Put it first in a
/// stack; content drawn after it sits on top.
pub fn calendar_backdrop(p: &Paint, size: [f32; 2], ghosts: bool) -> El {
    let [w, h] = size;
    let line = fade(p.border, 0.55);
    let mut layer = el().key("backdrop").pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0));

    let mut y = 0.0;
    let mut i = 0;
    while y < h {
        layer = layer.child(el().key(format!("hour-{i}")).h(1.0).fill(line).pin(Some(0.0), Some(y), Some(0.0), None));
        y += ROW;
        i += 1;
    }
    let centre = w / 2.0;
    let first = -(centre / COL).floor();
    let mut k = first;
    while centre + k * COL < w {
        let x = centre + k * COL;
        layer = layer.child(el().key(format!("day-{k}")).w(1.0).fill(line).pin(Some(x), Some(0.0), None, Some(0.0)));
        k += 1.0;
    }

    // `radial-gradient(120% 100% at 50% 45%, black 35%, transparent 92%)`, inverted.
    let clear = p.background.alpha(0.0);
    layer = layer.child(
        el().key("grid-fade")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .radial_gradient([0.5, 0.45], [1.2 * w, h], [(0.35, clear), (0.92, p.background), (1.0, p.background)]),
    );

    if ghosts && w >= SM {
        for g in &GHOSTS {
            layer = layer.child(ghost(p, g, centre));
        }
    }
    layer
}

fn ghost(p: &Paint, g: &Ghost, centre: f32) -> El {
    let content = rune::col()
        .key("ghost-body")
        .w_full()
        .h_full()
        .pt(3.5)
        .pb(3.5)
        .pr(7.0)
        .pl(10.5)
        .child(text(g.title).key("title").font(theme::TEXT_SM_MEDIUM).color(p.foreground))
        .child(text(g.time).key("time").font(theme::TEXT_XS).color(p.muted_foreground).truncate());
    EventCard::new(format!("ghost-{}", g.title), theme::event(g.event))
        .build(p, content)
        .w(COL - 2.0 * CELL_GAP)
        .h(g.row_span * ROW - 2.0 * CELL_GAP)
        .absolute(centre + g.col * COL + CELL_GAP, g.row * ROW + CELL_GAP)
        .opacity(0.55)
}
