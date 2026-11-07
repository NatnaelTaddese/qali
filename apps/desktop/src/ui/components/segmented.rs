//! A segmented control after the web's view switch (`calendar.tsx`): `rounded-lg bg-secondary
//! p-0.5`, options `rounded-md px-2.5 py-1 font-medium`, the selected one on `bg-background`
//! with `shadow-sm`. One keyed thumb sits under the labels and springs to the selected option.

use rune::tok::motion;
use rune::{Cursor, El, el, row, text};

use crate::ui::theme::{self, Paint, black, rem};

/// Every option gets the same width, so the thumb's position is just its index.
const OPTION_W: f32 = 60.0;
const PAD: f32 = rem(0.125);
const OPTION_H: f32 = rem(0.875) * 1.25 + rem(0.25) * 2.0;

/// `options` are `(key, label)`; `on_select(index)` builds each option's press handler.
pub fn segmented<S: 'static>(
    p: &Paint,
    key: &str,
    options: &[(&str, &str)],
    selected: usize,
    on_select: impl Fn(usize) -> Box<dyn Fn(&mut S)>,
) -> El {
    let thumb = el()
        .key("thumb")
        .w(OPTION_W)
        .h(OPTION_H)
        .radius(theme::RADIUS - 2.0)
        .fill(p.background)
        .shadow(1.0, 2.0, black(0.08))
        .motion(motion::SNAPPY)
        .absolute(PAD + selected as f32 * OPTION_W, PAD);
    let mut options_row = row().key("options");
    for (i, (opt_key, label)) in options.iter().enumerate() {
        let on = i == selected;
        let handler = on_select(i);
        options_row = options_row.child(
            row()
                .key(opt_key.to_string())
                .role("radio")
                .checked(on)
                .label(label.to_string())
                .focusable(true)
                .w(OPTION_W)
                .h(OPTION_H)
                .center()
                .cursor(Cursor::Pointer)
                .child(text(label.to_string()).font(theme::TEXT_SM_MEDIUM).color(if on { p.foreground } else { p.muted_foreground }))
                .on_press(move |s: &mut S| handler(s)),
        );
    }
    el().key(key.to_string())
        .role("radiogroup")
        .padding(PAD)
        .radius(theme::RADIUS_LG)
        .fill(p.secondary)
        .child(thumb)
        .child(options_row)
}
