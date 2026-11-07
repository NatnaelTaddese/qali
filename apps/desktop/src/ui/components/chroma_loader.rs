//! `ChromaLoader`, after `packages/ui/src/components/chroma-loader.tsx`: the full-window brand
//! loader, a Fraunces "Q" with the `--chroma-*` band travelling through it on a 3s loop.
//!
//! The web clips a sweeping gradient to the glyph (`background-clip: text`). Rune can't clip a
//! fill to text, so the glyph takes the colour of the band at its centre instead: the same
//! stops, the same 3s period, one colour at a time.

use rune::{Color, El, col, text};

use crate::ui::theme::{self, Paint, mix};

/// The loop's period, `chroma-loop-sweep 3s linear infinite`.
pub const PERIOD: f64 = 3.0;

/// The `.chroma-loop` gradient tile: foreground, the five chroma colours, foreground, twice.
fn band(p: &Paint) -> [(f32, Color); 13] {
    let [c1, c2, c3, c4, c5] = theme::chroma();
    let fg = p.foreground;
    [
        (0.0, fg),
        (0.10, c1),
        (0.18, c2),
        (0.25, c3),
        (0.32, c4),
        (0.40, c5),
        (0.50, fg),
        (0.60, c1),
        (0.68, c2),
        (0.75, c3),
        (0.82, c4),
        (0.90, c5),
        (1.0, fg),
    ]
}

/// The colour under the glyph's centre `t` seconds in. The tile is twice the container wide and
/// moves one tile per period, so the centre starts a quarter of the way in.
pub fn colour_at(p: &Paint, t: f64) -> Color {
    let u = ((0.25 + t / PERIOD).rem_euclid(1.0)) as f32;
    let stops = band(p);
    for pair in stops.windows(2) {
        let ((a, ca), (b, cb)) = (pair[0], pair[1]);
        if u <= b {
            return mix(ca, cb, ((u - a) / (b - a)).clamp(0.0, 1.0));
        }
    }
    p.foreground
}

pub fn chroma_loader(p: &Paint, t: f64) -> El {
    col()
        .key("chroma-loader")
        .role("progressbar")
        .label("Loading")
        .w_full()
        .h_full()
        .center()
        .fill(p.background)
        .child(text("Q").key("chroma-q").font(theme::DISPLAY_4XL_EXTRABOLD.tracking(-0.025 * theme::rem(2.25))).color(colour_at(p, t)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_band_loops_back_to_the_foreground_every_half_period() {
        let p = theme::paint(false, 2.0);
        // u = 0.5 (the seam) lands at t = 0.75 s and again a full period later.
        assert_eq!(colour_at(&p, 0.75), p.foreground);
        assert_eq!(colour_at(&p, 3.75), p.foreground);
        assert_ne!(colour_at(&p, 0.0), p.foreground);
    }
}
