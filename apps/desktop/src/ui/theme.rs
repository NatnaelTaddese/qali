//! The web app's design tokens (`packages/ui/src/styles/globals.css`) as Rune colours and
//! type styles. The web authors in OKLCH, which Rune takes as-is. The web's root font size is
//! 14px, so Tailwind's rem-based classes are `rem(n)` points here (`h-10` = `rem(2.5)` = 35).
//! The whole token set is here, used or not yet.
#![allow(dead_code)]

use rune::tok::{Family, TextStyle};
use rune::{Color, oklch, oklcha};

use crate::data::colors::{PALETTE_HUES, Swatch};

/// The web's `html { font-size }`.
pub const REM: f32 = 14.0;

pub const fn rem(n: f32) -> f32 {
    n * REM
}

#[derive(Clone, Copy, Debug)]
pub struct Paint {
    pub dark: bool,
    pub background: Color,
    pub foreground: Color,
    pub card: Color,
    pub muted: Color,
    pub muted_foreground: Color,
    pub accent: Color,
    /// `--calendar-header`: the toolbar, date row and gutter header.
    pub calendar_header: Color,
    /// Tailwind's `red-500`: the now line and its pill.
    pub now: Color,
    pub primary: Color,
    pub primary_foreground: Color,
    pub secondary: Color,
    pub secondary_foreground: Color,
    pub border: Color,
    pub input: Color,
    pub ring: Color,
    pub destructive: Color,
    pub link: Color,
    /// 1 physical pixel, for hairlines.
    pub hair: f32,
}

/// A `#rrggbb` colour (the web's dark surfaces are authored in hex): Rune colours are linear.
pub fn srgb(rgb: u32) -> Color {
    let ch = |shift: u32| {
        let c = ((rgb >> shift) & 0xff) as f32 / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    Color { r: ch(16), g: ch(8), b: ch(0), a: 1.0 }
}

pub fn white(alpha: f32) -> Color {
    Color { a: alpha, ..Color::WHITE }
}

pub fn black(alpha: f32) -> Color {
    Color { a: alpha, ..Color::BLACK }
}

/// `color-mix(in oklab, a, b t)`: `t` of the way from `a` to `b`, alpha included.
pub fn mix(a: Color, b: Color, t: f32) -> Color {
    let (x, y) = (a.to_oklab(), b.to_oklab());
    Color::from_oklab(std::array::from_fn(|i| x[i] + (y[i] - x[i]) * t))
}

/// Tailwind's `c/n`: the colour at `opacity` of its own alpha.
pub fn fade(c: Color, opacity: f32) -> Color {
    c.alpha(c.a * opacity)
}

pub fn paint(dark: bool, scale: f32) -> Paint {
    let hair = 1.0 / scale.max(1.0);
    let destructive = oklch(0.62, 0.22, 25.0);
    if dark {
        Paint {
            dark,
            background: srgb(0x111111),
            foreground: oklch(0.96, 0.0, 0.0),
            card: srgb(0x1b1b1b),
            muted: srgb(0x1b1b1b),
            muted_foreground: oklch(0.62, 0.0, 0.0),
            accent: oklch(0.28, 0.0, 0.0),
            calendar_header: srgb(0x0e0e0e),
            now: oklch(0.637, 0.237, 25.331),
            primary: oklch(0.96, 0.0, 0.0),
            primary_foreground: srgb(0x111111),
            secondary: srgb(0x1b1b1b),
            secondary_foreground: oklch(0.96, 0.0, 0.0),
            border: white(0.05),
            input: white(0.05),
            ring: white(0.1),
            destructive,
            link: oklch(0.72, 0.15, 255.0),
            hair,
        }
    } else {
        Paint {
            dark,
            background: oklch(0.99, 0.0, 0.0),
            foreground: oklch(0.13, 0.0, 0.0),
            card: oklch(0.97, 0.0, 0.0),
            muted: oklch(0.97, 0.0, 0.0),
            muted_foreground: oklch(0.47, 0.0, 0.0),
            accent: oklch(0.94, 0.0, 0.0),
            calendar_header: oklch(0.982, 0.0, 0.0),
            now: oklch(0.637, 0.237, 25.331),
            primary: oklch(0.13, 0.0, 0.0),
            primary_foreground: oklch(0.99, 0.0, 0.0),
            secondary: oklch(0.97, 0.0, 0.0),
            secondary_foreground: oklch(0.13, 0.0, 0.0),
            border: oklcha(0.13, 0.0, 0.0, 0.06),
            input: oklcha(0.13, 0.0, 0.0, 0.06),
            ring: oklcha(0.13, 0.0, 0.0, 0.12),
            destructive,
            link: oklch(0.52, 0.17, 255.0),
            hair,
        }
    }
}

/// `--event-N` (1-based, as the web names them): one lightness and chroma band in both themes.
pub fn event(n: usize) -> Color {
    event_color(Swatch::Hue(n - 1))
}

pub fn event_color(swatch: Swatch) -> Color {
    match swatch {
        Swatch::Neutral => oklch(0.68, 0.02, 250.0),
        Swatch::Hue(i) => {
            let (l, c) = [(0.72, 0.15), (0.74, 0.15), (0.8, 0.13), (0.75, 0.15), (0.76, 0.12), (0.72, 0.14), (0.7, 0.15), (0.7, 0.16)][i];
            oklch(l, c, PALETTE_HUES[i])
        }
    }
}

/// `--chroma-1..5`, the brand band the loader sweeps through.
pub fn chroma() -> [Color; 5] {
    [srgb(0xc679c4), srgb(0xfa3d1d), srgb(0xffb005), srgb(0xe1e1fe), srgb(0x0358f7)]
}

/// `--radius` (0.625rem), and Tailwind's steps off it.
pub const RADIUS: f32 = rem(0.625);
pub const RADIUS_LG: f32 = RADIUS;
pub const RADIUS_XL: f32 = RADIUS + 4.0;
pub const RADIUS_4XL: f32 = RADIUS + 22.0;

/// Tailwind's type scale at the web's 14px root. `leading-tight` (1.25) is Rune's default.
pub const TEXT_XS: TextStyle = TextStyle::new(rem(0.75), 400.0);
pub const TEXT_SM: TextStyle = TextStyle::new(rem(0.875), 400.0);
pub const TEXT_SM_MEDIUM: TextStyle = TextStyle::new(rem(0.875), 500.0);
/// `font-display`: Fraunces (the static cuts are built at SOFT 100, WONK 1).
pub const DISPLAY_2XL_BOLD: TextStyle = TextStyle::new(rem(1.5), 700.0).family(Family::Named("Fraunces"));
pub const DISPLAY_4XL_EXTRABOLD: TextStyle = TextStyle::new(rem(2.25), 800.0).family(Family::Named("Fraunces"));

// The signed-in list's own scale (Lexend is the app's sans slot, `AppSpec::families`).
pub const BODY: TextStyle = TextStyle::new(13.0, 400.0);
pub const BODY_MEDIUM: TextStyle = TextStyle::new(13.0, 500.0);
pub const SMALL: TextStyle = TextStyle::new(12.0, 400.0);
pub const HEADING: TextStyle = TextStyle::new(13.0, 600.0);
pub const DISPLAY_SMALL: TextStyle = TextStyle::new(20.0, 700.0).family(Family::Named("Fraunces"));
