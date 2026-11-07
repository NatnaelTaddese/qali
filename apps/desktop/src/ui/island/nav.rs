//! The collapsed island (`NavRow`): sync now, create, a divider, and your avatar for the
//! account panel. Search and the booking link take their places as their features land.

use rune::{Cursor, El, Icon, el, icon, row};

use crate::app::{self, Island, State};
use crate::ui::components::avatar::avatar;
use crate::ui::components::icons_gen::{CALENDAR_03, PLUS_SIGN};
use crate::ui::components::spinner;
use crate::ui::theme::{Paint, fade, rem};

pub fn nav(s: &State, p: &Paint) -> El {
    // `NavButton`: `size-9 rounded-lg hover:bg-accent`. The web fills it (`bg-accent`) to mark
    // the calendar as the current page; the desktop has only the calendar, so on glass it stays
    // clear and only lights up under the pointer.
    let sync_icon = if s.syncing { spinner(rem(1.25), p.foreground) } else { icon(&CALENDAR_03, rem(1.25)).color(p.foreground) };
    let sync = nav_button(p, "sync", if s.syncing { "Syncing calendar" } else { "Sync calendar" }, sync_icon)
        .focusable(!s.syncing)
        .disabled(s.syncing)
        .on_press(app::sync_now);
    // Muted like the web's other NavButtons; the calendar glyph stays bright as the current page.
    let create = nav_button(p, "create-event", "Create", glyph(&PLUS_SIGN, p)).on_press(app::new_event_now);

    let (email, name) = s.user.as_ref().map_or(("", None), |u| (u.email.as_str(), Some(u.name.as_str())));
    let account = row()
        .key("account-button")
        .role("button")
        .label("Account")
        .focusable(true)
        .radius(rem(1.0))
        .cursor(Cursor::Pointer)
        .press_scale(0.94)
        .child(avatar("user-avatar", email, name, rem(2.0)))
        .on_press(|s: &mut State| s.island = Island::Account);

    row()
        .key("nav-row")
        .gap(rem(0.25))
        .center_y()
        .child(sync)
        .child(create)
        .child(el().key("divider").w(1.0).h(rem(1.5)).mx(rem(0.25)).fill(p.border))
        .child(account)
}

fn glyph(g: &'static Icon, p: &Paint) -> El {
    icon(g, rem(1.25)).color(p.muted_foreground)
}

/// `NavButton`: `size-9 rounded-lg`, lit under the pointer.
fn nav_button(p: &Paint, key: &str, label: &str, content: El) -> El {
    row()
        .key(key.to_string())
        .role("button")
        .label(label.to_string())
        .focusable(true)
        .size(rem(2.25), rem(2.25))
        .center()
        .radius(rem(0.75))
        .hover(fade(p.foreground, 0.08))
        .cursor(Cursor::Pointer)
        .press_scale(0.94)
        .child(content)
}
