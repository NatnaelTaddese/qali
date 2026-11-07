//! The window: the loader while the stored session is checked, sign-in, and the week. Screens
//! are built from `ui::components` and `ui::calendar`, mirroring the web's.

use rune::{Cx, El, Transition, col, el, row, text};

use super::calendar::home::home;
use super::components::chroma_loader;
use super::screens::sign_in::sign_in;
use super::theme::{self, rem};
use crate::app::{Phase, State};

/// The app draws its own titlebar (`App::titlebar`): the week's toolbar, or an empty band over
/// the other screens. Both drag the window.
pub const TITLEBAR_HEIGHT: f32 = super::calendar::toolbar::HEIGHT;

/// The window's size before its first layout.
pub const WINDOW: (f32, f32) = (1040.0, 720.0);

pub fn view(s: &State, cx: &mut Cx<State>) -> El {
    let p = theme::paint(s.dark(cx.system_dark()), cx.env().scale);
    // Room for the traffic lights (macOS), so the toolbar never runs under them.
    let leading = 20.0f32.max(cx.chrome_insets().leading + 12.0);
    let size = cx.layout_size("root").unwrap_or([WINDOW.0, WINDOW.1]);
    let body = match s.phase {
        Phase::Restoring => chroma_loader(&p, s.clock),
        Phase::SignedOut | Phase::Waiting => sign_in(s, &p, size),
        Phase::SignedIn => home(s, &p, cx, leading, size),
    };
    let screen = match s.phase {
        Phase::Restoring => "loader",
        Phase::SignedOut | Phase::Waiting => "sign-in",
        Phase::SignedIn => "home",
    };
    let mut root = el()
        .key("root")
        .w_full()
        .h_full()
        .fill(p.background)
        .child(col().key(screen).w_full().h_full().child(body).transition(Transition::blur_replace()));
    if let Some(picker) = crate::ui::island::when::day_picker(s, &p) {
        root = root.child(picker);
    }
    if s.phase != Phase::SignedIn {
        root = root.child(el().key("drag-band").w_full().h(TITLEBAR_HEIGHT).absolute(0.0, 0.0).window_drag());
    } else if let Some(error) = &s.error {
        // Until the island can show it, a signed-in error floats at the bottom of the week.
        root = root.child(
            row()
                .key("error-banner")
                .max_w(560.0)
                .px(rem(1.0))
                .py(rem(0.625))
                .radius(theme::RADIUS_XL)
                .fill(p.card)
                .border(1.0, p.border)
                .shadow(8.0, 24.0, theme::black(0.18))
                .child(text(error.clone()).font(theme::TEXT_SM).color(p.destructive).wrap())
                .pin(Some(rem(1.0)), None, None, Some(rem(1.0))),
        );
    }
    root
}
