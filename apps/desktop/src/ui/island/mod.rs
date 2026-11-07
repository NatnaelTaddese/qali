//! The island (`workspace/bottom-island.tsx`): one Liquid Glass container at the bottom of the
//! window. Collapsed it's the nav pill; opened it morphs (size and corner radius on a spring)
//! into a panel, and the content crossfades with a blur. `Esc` or a click on the calendar
//! closes it, and clicking another event swaps the panel in place.

mod account;
mod event_create;
mod event_detail;
mod nav;

use rune::{Cx, El, Spring, Transition, el, row};

use crate::app::{Island, State};
use crate::ui::glass::{Glass, glass_surface};
use crate::ui::theme::{Paint, black, fade, rem, white};

/// `SPRING_DOCK` (stiffness 380, damping 34, mass 0.9): about 0.4 s, barely any overshoot.
pub const SPRING_DOCK: Spring = Spring::new(0.4, 0.06);
/// `bottom-6`.
const BOTTOM: f32 = rem(1.5);

/// How much background colour sits under the glass: enough for text to read, with the
/// calendar still showing through the frost and bending in at the rim. The frost lifts and
/// shades a light base toward grey, so light mode needs more of it to stay white.
const GLASS_FILL_LIGHT: f32 = 0.6;
const GLASS_FILL_DARK: f32 = 0.55;
/// Frost turns a light panel grey, so light mode keeps it to a touch.
const FROST_LIGHT: f32 = 0.08;
const FROST_DARK: f32 = 0.45;
/// The edge is a hairline with a soft light along it, not a sculpted rim.
const RIM: f32 = 0.2;
const BEVEL: f32 = 3.0;
/// In light mode the calendar shows through clear glass too sharply behind text, so a calm
/// layer covers the interior, inset so the refracting, rim-lit edge stays in view.
const CALM_INSET: f32 = 5.0;
const CALM_LIGHT: f32 = 0.42;

pub fn island(s: &State, p: &Paint, cx: &mut Cx<State>) -> El {
    let _ = cx;
    let (key, width, radius, padding, content): (&str, Option<f32>, f32, (f32, f32), El) = match &s.island {
        Island::Nav => ("nav", None, 28.0, (rem(0.5), rem(0.375)), nav::nav(s, p)),
        Island::Event(_) => match s.island_event() {
            Some(event) => ("event", Some(rem(27.0)), 20.0, (rem(1.0), rem(1.0)), event_detail::event_detail(s, p, event)),
            None => ("nav", None, 28.0, (rem(0.5), rem(0.375)), nav::nav(s, p)),
        },
        Island::Account => ("account", Some(rem(19.0)), 20.0, (rem(1.0), rem(1.0)), account::account(s, p)),
        Island::Create => match &s.draft {
            Some(draft) => ("create", Some(rem(29.0)), 20.0, (rem(1.0), rem(1.0)), event_create::event_create(s, p, draft)),
            None => ("nav", None, 28.0, (rem(0.5), rem(0.375)), nav::nav(s, p)),
        },
    };
    // A one-pixel edge, a touch lighter than the glass in dark mode and darker in light.
    let border = if p.dark { white(0.06) } else { black(0.05) };
    let mut shell = el()
        .key("island")
        .role("navigation")
        .radius(radius)
        .fill(fade(p.background, if p.dark { GLASS_FILL_DARK } else { GLASS_FILL_LIGHT }))
        .border(p.hair, border)
        .shadow(10.0, 30.0, black(if p.dark { 0.45 } else { 0.18 }))
        .px(padding.0)
        .py(padding.1)
        .motion(SPRING_DOCK)
        // `overflow-hidden`: while the shell springs between sizes, the incoming content is
        // already at its final layout and must not spill past the glass.
        .clip_rounded(radius)
        .child(glass_surface(radius, Glass { frost: if p.dark { FROST_DARK } else { FROST_LIGHT }, rim: RIM, bevel: BEVEL, shadow: 0.0 }));
    if !p.dark {
        shell = shell.child(
            el().key("calm")
                .radius(radius - CALM_INSET)
                .fill(fade(p.background, CALM_LIGHT))
                .pin(Some(CALM_INSET), Some(CALM_INSET), Some(CALM_INSET), Some(CALM_INSET)),
        );
    }
    shell = shell
        .child(el().key(format!("island-{key}")).w_full().child(content).transition(Transition::blur_replace()));
    if let Some(w) = width {
        shell = shell.w(w);
    }
    // A full-width band along the bottom centres the island; it has no handlers, so clicks
    // beside the island reach the calendar.
    row().key("island-band").pin(Some(0.0), None, Some(0.0), Some(BOTTOM)).px(rem(1.0)).center().child(shell)
}
