//! `ToggleSwitch`'s look: a small pill whose knob springs across; filled with the primary
//! colour when on. Only the visual: the row around it (the switch with its label) carries the
//! `switch` role, focus and the press, so a click on the knob or the label toggles alike.

use rune::tok::motion;
use rune::{El, el};

use crate::ui::theme::{Paint, black, fade};

const W: f32 = 30.0;
const H: f32 = 18.0;
const KNOB: f32 = 14.0;

pub fn switch(p: &Paint, key: &str, on: bool) -> El {
    let knob = el()
        .key("knob")
        .size(KNOB, KNOB)
        .radius(KNOB / 2.0)
        .fill(if on { p.primary_foreground } else { p.background })
        .shadow(1.0, 2.0, black(0.15))
        .motion(motion::SNAPPY)
        .absolute(if on { W - KNOB - 2.0 } else { 2.0 }, 2.0);
    el().key(key.to_string())
        .role("none")
        .size(W, H)
        .radius(H / 2.0)
        .fill(if on { p.primary } else { fade(p.foreground, 0.15) })
        .motion(motion::SNAPPY)
        .child(knob)
}
