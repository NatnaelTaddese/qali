//! The collapsed island (`NavRow`): sync now, a divider, and your avatar for the account panel.
//! Search, create and the booking link join as their phases land.

use rune::{Cursor, El, el, icon, row};

use crate::app::{self, Island, State};
use crate::ui::components::avatar::avatar;
use crate::ui::components::icons_gen::CALENDAR_03;
use crate::ui::components::spinner;
use crate::ui::theme::{Paint, fade, rem};

pub fn nav(s: &State, p: &Paint) -> El {
    // `NavButton`: `size-9 rounded-lg hover:bg-accent`. The web fills it (`bg-accent`) to mark
    // the calendar as the current page; the desktop has only the calendar, so on glass it stays
    // clear and only lights up under the pointer.
    let sync_icon = if s.syncing { spinner(rem(1.25), p.foreground) } else { icon(&CALENDAR_03, rem(1.25)).color(p.foreground) };
    let sync = row()
        .key("sync")
        .role("button")
        .label(if s.syncing { "Syncing calendar" } else { "Sync calendar" })
        .focusable(!s.syncing)
        .disabled(s.syncing)
        .size(rem(2.25), rem(2.25))
        .center()
        .radius(rem(0.75))
        .hover(fade(p.foreground, 0.08))
        .cursor(Cursor::Pointer)
        .press_scale(0.94)
        .child(sync_icon)
        .on_press(app::sync_now);

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
        .child(el().key("divider").w(1.0).h(rem(1.5)).mx(rem(0.25)).fill(p.border))
        .child(account)
}
