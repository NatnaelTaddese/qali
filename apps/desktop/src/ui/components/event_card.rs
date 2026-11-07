//! The web's event-card recipe, shared by the login card and the calendar backdrop's ghost
//! events: the hue mixed 22% into `--card`, a 3px accent pill inset from the left edge, a
//! `ring-border/60` outline with a faint inset ring, and a drop shadow.

use rune::{Color, El, Shadow, el};

use crate::ui::theme::{Paint, black, fade, mix, white};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Elevation {
    /// No shadow (the all-day band's cards).
    None,
    /// `shadow-sm`.
    Sm,
    /// `shadow-lg`.
    Lg,
}

pub struct EventCard {
    key: String,
    hue: Color,
    radius: f32,
    /// How far the pill sits in from the card's top, bottom and left edges.
    pill_inset: f32,
    elevation: Elevation,
}

impl EventCard {
    pub fn new(key: impl Into<String>, hue: Color) -> Self {
        EventCard { key: key.into(), hue, radius: 8.75, pill_inset: 3.5, elevation: Elevation::Sm }
    }

    pub fn radius(mut self, radius: f32) -> Self {
        self.radius = radius;
        self
    }

    pub fn pill_inset(mut self, inset: f32) -> Self {
        self.pill_inset = inset;
        self
    }

    pub fn elevation(mut self, elevation: Elevation) -> Self {
        self.elevation = elevation;
        self
    }

    /// The tinted surface the card fills with.
    pub fn surface(hue: Color, p: &Paint) -> Color {
        mix(p.card, hue, 0.22)
    }

    /// Wraps `content`, which brings its own padding (measured from the card's edge).
    pub fn build(self, p: &Paint, content: El) -> El {
        let shadow = match self.elevation {
            Elevation::None => Shadow { x: 0.0, y: 0.0, blur: 0.0, spread: 0.0, color: Color::TRANSPARENT, inset: false },
            Elevation::Sm => Shadow { x: 0.0, y: 1.0, blur: 3.0, spread: 0.0, color: black(0.1), inset: false },
            Elevation::Lg => Shadow { x: 0.0, y: 10.0, blur: 15.0, spread: -3.0, color: black(0.1), inset: false },
        };
        let inset_ring = if p.dark { white(0.1) } else { black(0.1) };
        let pill = el()
            .key("pill")
            .w(3.0)
            .radius(1.5)
            .fill(self.hue)
            .pin(Some(self.pill_inset), Some(self.pill_inset), None, Some(self.pill_inset));
        el()
            .key(self.key)
            .radius(self.radius)
            .fill(Self::surface(self.hue, p))
            .border(1.0, inset_ring)
            .outline(1.0, 0.0, fade(p.border, 0.6))
            .box_shadow(shadow)
            .clip_rounded(self.radius)
            .child(content)
            .child(pill)
    }
}
