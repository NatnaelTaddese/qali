//! `Avatar` (calendar/avatar.tsx): a round initial on the guest's stable palette colour. The
//! palette stays light in both themes, so the initial is always dark (`text-black/75`).

use rune::tok::TextStyle;
use rune::{El, row, text};

use crate::data::detail::{avatar_hue, initial};
use crate::ui::theme::{self, black};

pub fn avatar(key: &str, email: &str, name: Option<&str>, size: f32) -> El {
    let label = name.filter(|n| !n.trim().is_empty()).unwrap_or(email);
    row()
        .key(key.to_string())
        .size(size, size)
        .center()
        .radius(size / 2.0)
        .fill(theme::event(avatar_hue(email)))
        .child(text(initial(label)).font(TextStyle::new((size * 0.42).max(9.0), 600.0)).color(black(0.75)))
}
