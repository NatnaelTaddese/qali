//! The create panel (`calendar/event-create.tsx`, the minimal form for now): a title field
//! that's focused when it opens, the time drawn on the grid, the calendar it goes in, and
//! Cancel / Create. Enter creates; Escape cancels. The full form arrives next.

use rune::tok::TextStyle;
use rune::{El, col, el, icon, text, text_input};

use crate::app::{self, Draft, State};
use crate::data::colors;
use crate::data::days::working_zone;
use crate::data::detail;
use crate::data::models::CalendarEvent;
use crate::ui::components::icons_gen::{CALENDAR_03, CLOCK_01};
use crate::ui::components::{Button, ButtonSize, ButtonVariant};
use crate::ui::theme::{self, Paint, rem};

pub fn event_create(s: &State, p: &Paint, draft: &Draft) -> El {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let use_24h = s.prefs.use_24h();
    // `text-base font-semibold`, borderless, as the web form's title.
    let title = text_input(&s.draft_title, TextStyle::new(rem(1.0), 600.0))
        .key("draft-title")
        .single_line()
        .placeholder("Add title", p.muted_foreground)
        .color(p.foreground)
        .w_full()
        .on_edit(|s: &mut State| &mut s.draft_title)
        .on_submit(|s: &mut State, _tx| app::create_event(s))
        // Escape cancels the new event rather than just leaving the field.
        .on_input_key(|s: &mut State, e: &rune::KeyEvent, _tx: &mut rune::Tx| {
            if e.key == rune::Key::Escape {
                s.close_island();
                return true;
            }
            false
        });

    let when = CalendarEvent { start_ms: draft.start_ms, end_ms: draft.end_ms, all_day: draft.all_day, ..Default::default() };
    let time = labelled(p, "draft-time", &CLOCK_01, text(detail::time_text(&when, zone, use_24h)).font(theme::TEXT_SM_MEDIUM).color(p.foreground));

    let calendar = draft.calendar_id.as_ref().and_then(|id| s.calendars.iter().find(|c| &c.id == id));
    let calendar_label = match calendar {
        Some(c) => {
            let dot = c.background_color.as_deref().map(|h| theme::event_color(colors::snap(h))).unwrap_or(p.muted_foreground);
            rune::row()
                .key("draft-calendar-name")
                .gap(rem(0.375))
                .center_y()
                .child(el().key("dot").size(rem(0.5), rem(0.5)).radius(rem(0.25)).fill(dot))
                .child(text(c.display_name().to_string()).font(theme::TEXT_SM).color(p.muted_foreground).truncate())
        }
        None => rune::row().key("draft-calendar-name").child(text("Your primary calendar").font(theme::TEXT_SM).color(p.muted_foreground)),
    };
    let calendar_row = labelled(p, "draft-calendar", &CALENDAR_03, calendar_label);

    let busy = draft.submitting;
    let actions = rune::row()
        .key("draft-actions")
        .w_full()
        .gap(rem(0.5))
        .justify_end()
        .child(Button::new("cancel-create", "Cancel").variant(ButtonVariant::Ghost).size(ButtonSize::Sm).disabled(busy).build(p).on_press(|s: &mut State| s.close_island()))
        .child(Button::new("create", "Create").size(ButtonSize::Sm).loading(busy, "Creating…").build(p).on_press(app::create_event));

    col().key("event-create").w_full().gap(rem(0.75)).child(title).child(time).child(calendar_row).child(actions)
}

/// A row with a muted 18px glyph beside its content, as the detail panel's rows.
fn labelled(p: &Paint, key: &str, glyph: &'static rune::Icon, content: El) -> El {
    rune::row()
        .key(key.to_string())
        .w_full()
        .gap(rem(0.75))
        .center_y()
        .child(icon(glyph, rem(1.125)).color(p.muted_foreground))
        .child(rune::col().key("content").grow(1.0).min_w(0.0).child(content))
}
