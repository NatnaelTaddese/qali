//! The account panel (`workspace/account-panel.tsx`): who you are, the theme switch, and sign
//! out. Settings arrives with phase 5.

use rune::tok::TextStyle;
use rune::{Cursor, El, Icon, col, icon, row, text};

use crate::app::{self, State};
use crate::settings::{self, ThemeChoice};
use crate::ui::components::avatar::avatar;
use crate::ui::components::icons_gen::{CANCEL_01, COMPUTER_SETTINGS, LOGOUT_01, MOON_01, SUN_01};
use crate::ui::theme::{self, Paint, fade, rem};

const THEMES: [(ThemeChoice, &str, &Icon); 3] =
    [(ThemeChoice::Dark, "Dark", &MOON_01), (ThemeChoice::Light, "Light", &SUN_01), (ThemeChoice::System, "Device", &COMPUTER_SETTINGS)];

pub fn account(s: &State, p: &Paint) -> El {
    let (name, email) = s.user.as_ref().map_or((None, String::new()), |u| (Some(u.name.clone()), u.email.clone()));
    let mut who = col().key("who").grow(1.0).min_w(0.0);
    if let Some(name) = name.clone() {
        who = who.child(text(name).key("account-name").font(theme::TEXT_SM_MEDIUM).color(p.foreground).truncate());
    }
    who = who.child(text(email.clone()).key("account-email").font(theme::TEXT_XS).color(p.muted_foreground).truncate());
    let header = row()
        .key("account-header")
        .w_full()
        .gap(rem(0.625))
        .center_y()
        .child(avatar("account-avatar", &email, name.as_deref(), rem(2.25)))
        .child(who)
        .child(
            row()
                .key("close")
                .role("button")
                .label("Close")
                .focusable(true)
                .size(rem(1.75), rem(1.75))
                .center()
                .radius(rem(0.875))
                .hover(p.accent)
                .cursor(Cursor::Pointer)
                .child(icon(&CANCEL_01, rem(1.0)).color(p.muted_foreground))
                .on_press(|s: &mut State| s.close_island()),
        );

    // `grid grid-cols-3 gap-1 rounded-2xl bg-muted p-1`, the chosen one on the background.
    let mut themes = row().key("themes").w_full().gap(rem(0.25)).padding(rem(0.25)).radius(theme::RADIUS + 8.0).fill(p.muted);
    for (choice, label, glyph) in THEMES {
        let on = s.theme == choice;
        let mut button = row()
            .key(format!("theme-{label}"))
            .role("button")
            .label(label)
            .checked(on)
            .focusable(true)
            .grow(1.0)
            .h(rem(2.0))
            .gap(rem(0.25))
            .center()
            .radius(theme::RADIUS_XL)
            .hover(fade(p.background, 0.6))
            .cursor(Cursor::Pointer)
            .child(icon(glyph, rem(1.0)).color(if on { p.foreground } else { p.muted_foreground }))
            .child(text(label).font(theme::TEXT_SM_MEDIUM).color(if on { p.foreground } else { p.muted_foreground }))
            .on_press(move |s: &mut State| {
                s.theme = choice;
                if app::is_running() {
                    settings::save(&settings::Settings { theme: choice });
                }
            });
        if on {
            button = button.fill(p.background).shadow(1.0, 2.0, theme::black(0.08));
        }
        themes = themes.child(button);
    }

    let sign_out = row()
        .key("sign-out")
        .role("button")
        .label("Sign out")
        .focusable(true)
        .w_full()
        .px(rem(0.75))
        .py(rem(0.625))
        .gap(rem(0.75))
        .center_y()
        .hover(fade(p.destructive, 0.1))
        .cursor(Cursor::Pointer)
        .child(icon(&LOGOUT_01, rem(1.0)).color(p.destructive))
        .child(text("Sign out").font(theme::TEXT_SM_MEDIUM).color(p.destructive))
        .on_press(|s: &mut State| {
            app::sign_out();
            s.signed_out(None);
        });

    col()
        .key("account")
        .w_full()
        .gap(rem(0.75))
        .child(header)
        .child(col().key("theme").gap(rem(0.375)).child(text("Theme").font(TextStyle::new(rem(0.75), 500.0)).color(p.muted_foreground).px(rem(0.5))).child(themes))
        .child(col().key("actions").w_full().radius(theme::RADIUS + 8.0).fill(fade(p.muted, 0.6)).clip_rounded(theme::RADIUS + 8.0).child(sign_out))
}
