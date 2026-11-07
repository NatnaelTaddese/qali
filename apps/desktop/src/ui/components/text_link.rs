//! An inline link: underlined text (`underline underline-offset-2`) that opens `url` in the
//! browser. Put it in a row with plain text runs around it.

use rune::tok::TextStyle;
use rune::{Color, Cursor, El, Span, rich};

pub fn text_link(key: &str, label: &str, url: &'static str, style: TextStyle, color: Color) -> El {
    rich(label.to_string(), vec![Span::new(0, label.len()).underline(color)])
        .key(key.to_string())
        .role("link")
        .label(label.to_string())
        .focusable(true)
        .font(style)
        .color(color)
        .cursor(Cursor::Pointer)
        .on_press_tx(move |_: &mut crate::app::State, tx| {
            let _ = tx.open_url(url);
        })
}
