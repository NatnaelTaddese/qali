//! `Button`, after `packages/ui/src/components/button.tsx` (its `cva` variants and sizes).
//!
//! ```ignore
//! Button::new("google", "Continue with Google")
//!     .size(Size::Lg)
//!     .radius(theme::RADIUS_XL)
//!     .full_width()
//!     .icon(google_mark)
//!     .loading(waiting, "Waiting for Google…")
//!     .build(&p)
//!     .on_press(|s: &mut State| ..)
//! ```

use rune::{Color, Cursor, El, row, text};
use rune::tok::{TextStyle, motion};

use super::spinner;
use crate::ui::glass::{Glass, glass_surface};
use crate::ui::theme::{self, Paint, fade, rem};

/// How opaque the primary colour under the glass is: enough that the button still reads as
/// the brand's black (white in dark) with its label legible, while what is behind it shows
/// through the frost and bends in at the rim. The lens's own tint multiplies (it can darken a
/// backdrop but never lighten it), so the colour goes in as a fill the glass then refracts.
const GLASS_FILL: f32 = 0.9;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Variant {
    #[default]
    Default,
    Outline,
    Secondary,
    Ghost,
    Destructive,
    Link,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    #[default]
    Default,
    Xs,
    Sm,
    Lg,
    Icon,
    IconXs,
    IconSm,
    IconLg,
}

impl Size {
    /// (height, horizontal padding, gap); icon sizes are square and unpadded.
    fn metrics(self) -> (f32, f32, f32) {
        match self {
            Size::Default => (rem(2.25), rem(0.75), rem(0.375)),
            Size::Xs => (rem(1.5), rem(0.625), rem(0.25)),
            Size::Sm => (rem(2.0), rem(0.75), rem(0.25)),
            Size::Lg => (rem(2.5), rem(1.0), rem(0.375)),
            Size::Icon => (rem(2.25), 0.0, 0.0),
            Size::IconXs => (rem(1.5), 0.0, 0.0),
            Size::IconSm => (rem(2.0), 0.0, 0.0),
            Size::IconLg => (rem(2.5), 0.0, 0.0),
        }
    }

    fn is_icon(self) -> bool {
        matches!(self, Size::Icon | Size::IconXs | Size::IconSm | Size::IconLg)
    }

    fn text(self) -> TextStyle {
        if self == Size::Xs { TextStyle::new(rem(0.75), 500.0) } else { theme::TEXT_SM_MEDIUM }
    }

    /// `[&_svg]:size-4`, or `size-3` on the extra-small sizes.
    pub fn icon_size(self) -> f32 {
        if matches!(self, Size::Xs | Size::IconXs) { rem(0.75) } else { rem(1.0) }
    }
}

/// Fill, text colour, border and hover overlay for a variant.
struct Look {
    fill: Color,
    ink: Color,
    border: Color,
    hover: Color,
}

fn look(variant: Variant, p: &Paint) -> Look {
    let none = Color::TRANSPARENT;
    match variant {
        // `hover:bg-primary/80`: the background showing 20% through.
        Variant::Default => Look { fill: p.primary, ink: p.primary_foreground, border: none, hover: fade(p.background, 0.2) },
        Variant::Outline => Look {
            fill: if p.dark { none } else { p.background },
            ink: p.foreground,
            border: p.border,
            hover: if p.dark { fade(p.input, 0.3) } else { p.muted },
        },
        Variant::Secondary => Look {
            fill: p.secondary,
            ink: p.secondary_foreground,
            border: none,
            hover: fade(p.foreground, 0.05),
        },
        Variant::Ghost => Look { fill: none, ink: p.foreground, border: none, hover: if p.dark { fade(p.muted, 0.5) } else { p.muted } },
        Variant::Destructive => {
            let (rest, hover) = if p.dark { (0.2, 0.3) } else { (0.1, 0.2) };
            Look {
                fill: fade(p.destructive, rest),
                ink: p.destructive,
                border: none,
                hover: fade(p.destructive, hover - rest),
            }
        }
        Variant::Link => Look { fill: none, ink: p.primary, border: none, hover: none },
    }
}

pub struct Button {
    key: String,
    label: Option<String>,
    icon: Option<El>,
    variant: Variant,
    size: Size,
    radius: f32,
    full_width: bool,
    disabled: bool,
    loading: Option<String>,
    glass: bool,
}

impl Button {
    pub fn new(key: impl Into<String>, label: impl Into<String>) -> Self {
        Button {
            key: key.into(),
            label: Some(label.into()),
            icon: None,
            variant: Variant::Default,
            size: Size::Default,
            radius: theme::RADIUS_4XL,
            full_width: false,
            disabled: false,
            loading: None,
            glass: true,
        }
    }

    /// An icon-only button (`size="icon"`); `label` is its accessible name.
    pub fn icon_only(key: impl Into<String>, icon: El) -> Self {
        Button { label: None, icon: Some(icon), size: Size::Icon, ..Button::new(key, "") }
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    /// Overrides the pill (`rounded-4xl`) default, as `className="rounded-xl"` does.
    pub fn radius(mut self, radius: f32) -> Self {
        self.radius = radius;
        self
    }

    pub fn full_width(mut self) -> Self {
        self.full_width = true;
        self
    }

    /// A leading icon, sized by the button (`Size::icon_size`).
    pub fn icon(mut self, icon: El) -> Self {
        self.icon = Some(icon);
        self
    }

    /// The primary variant is Liquid Glass tinted with `--primary` (as the native app's is);
    /// `glass(false)` gives it the web's flat fill. Other variants are always flat.
    pub fn glass(mut self, glass: bool) -> Self {
        self.glass = glass;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// While `Some`, a spinner replaces the icon, the label reads `label`, and the button is
    /// disabled (`aria-busy`), as the web's sign-in button does while it redirects.
    pub fn loading(mut self, loading: bool, label: impl Into<String>) -> Self {
        self.loading = loading.then(|| label.into());
        self
    }

    pub fn build(self, p: &Paint) -> El {
        let (height, px, gap) = self.size.metrics();
        let look = look(self.variant, p);
        let busy = self.loading.is_some();
        let disabled = self.disabled || busy;
        let label = self.loading.clone().or(self.label.clone());
        let glass = self.glass && self.variant == Variant::Default;
        // `disabled:opacity-50`. Group opacity would draw the glass into an offscreen layer,
        // where the lens can't see the card behind it, so a glass button dims its fill and its
        // content instead and keeps the glass in the main pass.
        let dim = if disabled { 0.5 } else { 1.0 };
        let ink = if glass { fade(look.ink, dim) } else { look.ink };

        let mut b = row()
            .key(self.key)
            .role("button")
            .focusable(!disabled)
            .disabled(disabled)
            .h(height)
            .center()
            .gap(gap)
            .radius(self.radius)
            .fill(if glass { fade(look.fill, GLASS_FILL * dim) } else { look.fill })
            .border(1.0, look.border)
            .motion(motion::SNAPPY);
        b = if self.size.is_icon() { b.w(height) } else { b.px(px) };
        if self.full_width {
            b = b.w_full();
        }
        if let Some(name) = &label {
            b = b.label(name.clone());
        }
        if disabled {
            if !glass {
                b = b.opacity(dim);
            }
        } else {
            b = b.cursor(Cursor::Pointer).press_scale(0.985);
            if look.hover.a > 0.0 {
                b = b.hover(look.hover);
            }
        }

        if glass {
            b = b.child(glass_surface(self.radius, Glass::CONTROL));
        }
        if busy {
            b = b.child(spinner::spinner(self.size.icon_size(), ink));
        } else if let Some(icon) = self.icon {
            let icon = icon.size(self.size.icon_size(), self.size.icon_size());
            b = b.child(if glass && disabled { icon.opacity(dim) } else { icon });
        }
        if let Some(label) = label.filter(|l| !l.is_empty() && !self.size.is_icon()) {
            b = b.child(text(label).key("label").font(self.size.text()).color(ink));
        }
        b
    }
}
