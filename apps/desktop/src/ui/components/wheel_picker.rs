//! `WheelPicker`'s look (`@qali/ui` `motion/wheel-picker.tsx`): rows on a drum, dimmed as they
//! turn away, behind a faint band that holds the selected row in full ink. This draws the
//! drum at a given position; the caller turns it (`island::when`).

use rune::{Cursor, El, el, row, text};

use crate::data::wheel::{self, ITEM_H};
use crate::ui::theme::{self, Paint, fade};

/// `scroll` is the drum's position in rows: the selected index when it rests.
pub fn wheel_picker(p: &Paint, key: &str, label: &str, rows: &[String], scroll: f32) -> El {
    let g = wheel::geometry();
    let middle = g.height / 2.0;
    // `rounded-xs border bg-card`, with the band (`rounded-md bg-foreground/[0.04]`) across it.
    let mut drum = el()
        .key(key.to_string())
        .role("listbox")
        .label(label.to_string())
        .focusable(true)
        .grow(1.0)
        .h(g.height)
        .radius(2.0)
        .fill(p.card)
        .border(1.0, p.border)
        .clip_rounded(2.0)
        .cursor(Cursor::Grab)
        .child(el().key("band").h(ITEM_H).radius(6.0).fill(fade(p.foreground, 0.04)).pin(Some(0.0), Some(middle - ITEM_H / 2.0), Some(0.0), None));
    for (i, label) in rows.iter().enumerate() {
        let Some((y, scale, opacity)) = wheel::pose(&g, i, scroll) else { continue };
        // The row crossing the band reads in full ink, as the web's crisp copy of the drum.
        let ink = if (i as f32 - scroll).abs() < 0.5 { p.foreground } else { p.muted_foreground };
        drum = drum.child(
            row()
                .key(format!("row-{i}"))
                .h(ITEM_H)
                .center()
                .scale(scale)
                .opacity(opacity)
                .pin(Some(0.0), Some(middle + y - ITEM_H / 2.0), Some(0.0), None)
                .child(text(label.clone()).font(theme::TEXT_SM_MEDIUM).color(ink)),
        );
    }
    drum
}
