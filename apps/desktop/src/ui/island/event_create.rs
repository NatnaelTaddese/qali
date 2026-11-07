//! The event form (`calendar/event-create.tsx` and the edit form): the title, focused when it
//! opens; the day and the times as quarter-hour steppers, with All day; a place or a Google
//! Meet link; guests; the repeat rule; the calendar; the colour; Busy and Private; reminders;
//! and the description. Enter in the title saves, Escape anywhere cancels. Saving an edit of
//! a repeating event first asks how far it reaches.

use rune::tok::TextStyle;
use rune::{Color, Cursor, El, Icon, col, el, icon, row, text, text_input};

use crate::app::{self, Draft, FormMenu, State};
use crate::data::colors::{self, Swatch};
use crate::data::days::working_zone;
use crate::data::detail;
use crate::data::draft as steps;
use crate::data::week::SNAP_MS;
use crate::ui::components::icons_gen::*;
use crate::ui::components::switch::switch;
use crate::ui::components::{Button, ButtonSize, ButtonVariant};
use crate::ui::theme::{self, Paint, fade, rem};

const ARROW: f32 = rem(1.5);
const DOT: f32 = rem(1.0);

pub fn event_create(s: &State, p: &Paint, draft: &Draft) -> El {
    let editing = draft.editing.is_some();
    let busy = draft.submitting;
    let caps = draft.editing.as_ref().map(|e| {
        let calendar = e.local_calendar_id.as_ref().and_then(|id| s.calendars.iter().find(|c| &c.id == id));
        crate::data::permissions::capabilities(e, calendar)
    });
    let actions = row()
        .key("draft-actions")
        .w_full()
        .gap(rem(0.5))
        .justify_end()
        .child(Button::new("cancel-create", "Cancel").variant(ButtonVariant::Ghost).size(ButtonSize::Sm).disabled(busy).build(p).on_press(cancel))
        .child(if editing {
            Button::new("save", "Save").size(ButtonSize::Sm).loading(busy, "Saving…").build(p).on_press(app::create_event)
        } else {
            Button::new("create", "Create").size(ButtonSize::Sm).loading(busy, "Creating…").build(p).on_press(app::create_event)
        });

    let mut form = col()
        .key("event-create")
        .w_full()
        .gap(rem(0.75))
        .child(title(s, p))
        .child(when(s, p, draft))
        .child(super::repeat::repeat_row(s, p, draft))
        .child(place(s, p, draft))
        .child(super::guests::guests_row(s, p, draft, caps.as_ref()))
        .child(calendar(s, p, draft));
    if draft.menu == Some(FormMenu::Calendar) {
        form = form.child(calendar_list(s, p, draft));
    }
    form = form
        .child(color_row(s, p, draft))
        .child(availability(p, draft))
        .child(reminders(s, p, draft))
        .child(labelled(p, "draft-description", &TEXT_ALIGN_LEFT_01, field(s, p, Field::Description)));
    if draft.save_scopes_open {
        form = form.child(save_scopes(p));
    }
    form.child(actions)
}

/// How far an edit of a repeating event reaches (`SAVE_SCOPES`); choosing one saves.
fn save_scopes(p: &Paint) -> El {
    let mut list = col().key("save-scopes").w_full().gap(rem(0.125)).padding(rem(0.25)).radius(theme::RADIUS_XL).fill(fade(p.foreground, 0.04));
    for (scope, label) in app::SAVE_SCOPES {
        list = list.child(
            row()
                .key(format!("save-{scope}"))
                .role("button")
                .label(label)
                .focusable(true)
                .w_full()
                .px(rem(0.625))
                .py(rem(0.5))
                .radius(theme::RADIUS_LG)
                .hover(p.accent)
                .cursor(Cursor::Pointer)
                .child(text(label).font(theme::TEXT_SM_MEDIUM).color(p.foreground))
                .on_press(move |s: &mut State| app::save_event(s, scope)),
        );
    }
    list
}

fn cancel(s: &mut State) {
    s.cancel_form();
}

#[derive(Clone, Copy)]
enum Field {
    Title,
    Location,
    Description,
}

fn field(s: &State, p: &Paint, which: Field) -> El {
    let (edit, key, placeholder, style) = match which {
        Field::Title => (&s.draft_title, "draft-title", "Add title", TextStyle::new(rem(1.0), 600.0)),
        Field::Location => (&s.draft_location, "draft-location-input", "Add location", theme::TEXT_SM),
        Field::Description => (&s.draft_description, "draft-description-input", "Add description", theme::TEXT_SM),
    };
    let mut input = text_input(edit, style).key(key).placeholder(placeholder, p.muted_foreground).color(p.foreground).w_full().on_edit(move |s: &mut State| match which {
        Field::Title => &mut s.draft_title,
        Field::Location => &mut s.draft_location,
        Field::Description => &mut s.draft_description,
    });
    if !matches!(which, Field::Description) {
        input = input.single_line().on_submit(|s: &mut State, _tx| app::create_event(s));
    }
    input.on_input_key(|s: &mut State, e: &rune::KeyEvent, _tx: &mut rune::Tx| {
        if e.key == rune::Key::Escape {
            cancel(s);
            return true;
        }
        false
    })
}

/// `text-base font-semibold`, borderless, as the web form's title.
fn title(s: &State, p: &Paint) -> El {
    field(s, p, Field::Title)
}

/// The day, the start and end, and All day.
fn when(s: &State, p: &Paint, draft: &Draft) -> El {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let use_24h = s.prefs.use_24h();
    let day_of = |ms: f64| {
        if draft.all_day {
            detail::day_label(chrono::DateTime::from_timestamp_millis(ms as i64).unwrap_or_default().date_naive())
        } else {
            detail::day_label(crate::data::days::today(ms, zone))
        }
    };
    let all_day = draft.all_day;
    let day = stepper(p, "draft-day", day_of(draft.start_ms), move |s: &mut State, dir| {
        let zone = working_zone(s.prefs.time_zone.as_deref());
        edit_times(s, |d| steps::shift_days(d.start_ms, d.end_ms, dir, all_day, zone));
    });
    let toggle = row()
        .key("draft-all-day")
        .gap(rem(0.5))
        .center_y()
        .cursor(Cursor::Pointer)
        .child(text("All day").font(theme::TEXT_SM).color(p.muted_foreground))
        .child(switch(p, "draft-all-day-switch", "All day", all_day))
        .on_press(|s: &mut State| {
            let zone = working_zone(s.prefs.time_zone.as_deref());
            if let Some(d) = s.draft.as_mut() {
                (d.start_ms, d.end_ms) = if d.all_day { steps::to_timed(d.start_ms, zone) } else { steps::to_all_day(d.start_ms, d.end_ms, zone) };
                d.all_day = !d.all_day;
            }
        });
    let first = row().key("draft-day-row").w_full().center_y().justify_between().child(day).child(toggle);

    let second = if all_day {
        let last = steps::last_day_ms(draft.start_ms, draft.end_ms);
        row()
            .key("draft-span")
            .gap(rem(0.5))
            .center_y()
            .child(text("Until").font(theme::TEXT_SM).color(p.muted_foreground))
            .child(stepper(p, "draft-last-day", day_of(last), |s: &mut State, dir| edit_times(s, |d| steps::shift_last_day(d.start_ms, d.end_ms, dir))))
    } else {
        let clock = |ms| crate::ui::calendar::clock(ms, zone, use_24h, true);
        // An end on another day says which.
        let end_label = if crate::data::days::today(draft.end_ms - 1.0, zone) == crate::data::days::today(draft.start_ms, zone) {
            clock(draft.end_ms)
        } else {
            format!("{} {}", day_of(draft.end_ms), clock(draft.end_ms))
        };
        row()
            .key("draft-span")
            .gap(rem(0.25))
            .center_y()
            .child(stepper(p, "draft-start", clock(draft.start_ms), |s: &mut State, dir| edit_times(s, |d| steps::shift_start(d.start_ms, d.end_ms, dir as f64 * SNAP_MS))))
            .child(text("–").font(theme::TEXT_SM).color(p.muted_foreground))
            .child(stepper(p, "draft-end", end_label, |s: &mut State, dir| edit_times(s, |d| steps::shift_end(d.start_ms, d.end_ms, dir as f64 * SNAP_MS))))
    };
    labelled(p, "draft-time", &CLOCK_01, col().key("draft-when").w_full().gap(rem(0.25)).child(first).child(second))
}

fn edit_times(s: &mut State, f: impl FnOnce(&Draft) -> (f64, f64)) {
    if let Some(d) = s.draft.as_mut() {
        (d.start_ms, d.end_ms) = f(d);
    }
}

/// `‹ label ›`: the arrows step back and forward (`on_step(-1 | 1)`).
pub(super) fn stepper(p: &Paint, key: &str, label: String, on_step: impl Fn(&mut State, i64) + Clone + 'static) -> El {
    let back = on_step.clone();
    row()
        .key(key.to_string())
        .center_y()
        .radius(theme::RADIUS_LG)
        .fill(fade(p.foreground, 0.05))
        .child(arrow(p, "earlier", &ARROW_LEFT_01).on_press(move |s: &mut State| back(s, -1)))
        .child(text(label).key("value").font(theme::TEXT_SM_MEDIUM).color(p.foreground).px(rem(0.125)))
        .child(arrow(p, "later", &ARROW_RIGHT_01).on_press(move |s: &mut State| on_step(s, 1)))
}

fn arrow(p: &Paint, key: &str, glyph: &'static Icon) -> El {
    row()
        .key(key.to_string())
        .role("button")
        .label(if key == "earlier" { "Earlier" } else { "Later" })
        .focusable(true)
        .size(ARROW, ARROW)
        .center()
        .radius(theme::RADIUS_LG)
        .hover(p.accent)
        .press_scale(0.92)
        .cursor(Cursor::Pointer)
        .child(icon(glyph, rem(0.875)).color(p.muted_foreground))
}

/// A place, or a Google Meet link instead of one.
fn place(s: &State, p: &Paint, draft: &Draft) -> El {
    let meet = row()
        .key("draft-meet")
        .gap(rem(0.5))
        .center_y()
        .cursor(Cursor::Pointer)
        .child(text("Google Meet").font(theme::TEXT_SM).color(p.muted_foreground))
        .child(switch(p, "draft-meet-switch", "Add Google Meet", draft.meet))
        .on_press(|s: &mut State| {
            if let Some(d) = s.draft.as_mut() {
                d.meet = !d.meet;
            }
        });
    let (glyph, content): (&'static Icon, El) = if draft.meet {
        let has_link = draft.editing.as_ref().is_some_and(|e| e.conference_url.is_some());
        let note = if has_link { "Keeps its Google Meet link" } else { "A Meet link is added on save" };
        (&VIDEO_01, text(note).font(theme::TEXT_SM).color(p.foreground).truncate())
    } else {
        (&LOCATION_01, field(s, p, Field::Location))
    };
    labelled(p, "draft-place", glyph, row().key("draft-place-row").w_full().gap(rem(0.75)).center_y().child(col().key("where").grow(1.0).min_w(0.0).child(content)).child(meet))
}

fn calendar_dot(s: &State, p: &Paint, id: Option<&str>) -> Color {
    id.and_then(|id| s.calendars.iter().find(|c| c.id == id))
        .and_then(|c| c.background_color.as_deref())
        .map(|h| theme::event_color(colors::snap(h)))
        .unwrap_or(p.muted_foreground)
}

/// The calendar it goes in; pressing it lists the writable ones. An edit stays where it is.
fn calendar(s: &State, p: &Paint, draft: &Draft) -> El {
    let name = draft
        .calendar_id
        .as_ref()
        .and_then(|id| s.calendars.iter().find(|c| &c.id == id))
        .map_or("Your primary calendar".to_string(), |c| c.display_name().to_string());
    let movable = draft.editing.is_none() && s.writable_calendars().len() > 1;
    let mut label = row()
        .key("draft-calendar-name")
        .gap(rem(0.375))
        .center_y()
        .child(el().key("dot").size(rem(0.5), rem(0.5)).radius(rem(0.25)).fill(calendar_dot(s, p, draft.calendar_id.as_deref())))
        .child(text(name).font(theme::TEXT_SM).color(p.foreground).truncate());
    if movable {
        label = label
            .child(icon(&ARROW_DOWN_01, rem(0.875)).color(p.muted_foreground))
            .role("button")
            .label("Calendar")
            .focusable(true)
            .ml(-rem(0.375))
            .px(rem(0.375))
            .py(rem(0.125))
            .radius(theme::RADIUS_LG)
            .hover(p.accent)
            .cursor(Cursor::Pointer)
            .on_press(|s: &mut State| {
                super::repeat::toggle_menu(s, FormMenu::Calendar);
            });
    }
    labelled(p, "draft-calendar", &CALENDAR_03, row().key("draft-calendar-row").child(label))
}

fn calendar_list(s: &State, p: &Paint, draft: &Draft) -> El {
    let mut list = col().key("draft-calendars").w_full().gap(rem(0.125)).padding(rem(0.25)).radius(theme::RADIUS_XL).fill(fade(p.foreground, 0.04));
    for c in s.writable_calendars() {
        let id = c.id.clone();
        let chosen = draft.calendar_id.as_deref() == Some(c.id.as_str());
        list = list.child(
            row()
                .key(format!("calendar-{}", c.id))
                .role("button")
                .label(c.display_name().to_string())
                .focusable(true)
                .w_full()
                .gap(rem(0.5))
                .center_y()
                .px(rem(0.625))
                .py(rem(0.375))
                .radius(theme::RADIUS_LG)
                .hover(p.accent)
                .cursor(Cursor::Pointer)
                .child(el().key("dot").size(rem(0.5), rem(0.5)).radius(rem(0.25)).fill(calendar_dot(s, p, Some(&c.id))))
                .child(text(c.display_name().to_string()).font(theme::TEXT_SM).color(p.foreground).truncate().grow(1.0))
                .child(if chosen { icon(&TICK_02, rem(0.875)).color(p.foreground) } else { el().key("no-tick") })
                .on_press(move |s: &mut State| {
                    if let Some(d) = s.draft.as_mut() {
                        d.calendar_id = Some(id.clone());
                        d.menu = None;
                    }
                }),
        );
    }
    list
}

/// The calendar's own colour first, then one dot per palette hue.
fn color_row(s: &State, p: &Paint, draft: &Draft) -> El {
    let choice = |key: String, label: &str, fill: Color, value: Option<&'static str>| {
        let chosen = draft.color.as_deref() == value;
        let ring = if chosen { p.foreground } else { Color::TRANSPARENT };
        el().key(key)
            .role("radio")
            .label(label.to_string())
            .checked(chosen)
            .focusable(true)
            .size(DOT + 4.0, DOT + 4.0)
            .radius((DOT + 4.0) / 2.0)
            .border(1.5, ring)
            .center()
            .cursor(Cursor::Pointer)
            .press_scale(0.9)
            .child(el().key("swatch").size(DOT - 2.0, DOT - 2.0).radius((DOT - 2.0) / 2.0).fill(fill))
            .on_press(move |s: &mut State| {
                if let Some(d) = s.draft.as_mut() {
                    d.color = value.map(str::to_string);
                }
            })
    };
    let mut dots = row().key("draft-colors").gap(rem(0.375)).center_y().flex_wrap();
    dots = dots.child(choice("color-calendar".into(), "Calendar colour", calendar_dot(s, p, draft.calendar_id.as_deref()), None));
    for (key, swatch) in colors::color_choices() {
        let label = match swatch {
            Swatch::Hue(i) => format!("Colour {}", i + 1),
            Swatch::Neutral => "Grey".to_string(),
        };
        dots = dots.child(choice(format!("color-{key}"), &label, theme::event_color(swatch), Some(key)));
    }
    labelled(p, "draft-color", &PAINT_BOARD, dots)
}

/// Busy or free, and private.
fn availability(p: &Paint, draft: &Draft) -> El {
    let toggle = |key: &'static str, label: &'static str, on: bool, flip: fn(&mut Draft)| {
        row()
            .key(key)
            .gap(rem(0.5))
            .center_y()
            .cursor(Cursor::Pointer)
            .child(text(label).font(theme::TEXT_SM).color(p.foreground))
            .child(switch(p, &format!("{key}-switch"), label, on))
            .on_press(move |s: &mut State| {
                if let Some(d) = s.draft.as_mut() {
                    flip(d);
                }
            })
    };
    labelled(
        p,
        "draft-availability",
        &SQUARE_LOCK_01,
        row()
            .key("draft-flags")
            .gap(rem(1.25))
            .center_y()
            .child(toggle("draft-busy", "Busy", draft.busy, |d| d.busy = !d.busy))
            .child(toggle("draft-private", "Private", draft.private, |d| d.private = !d.private)),
    )
}

/// Default, None, then the presets; a minute chip toggles, so several can be on.
fn reminders(s: &State, p: &Paint, draft: &Draft) -> El {
    let use_24h = s.prefs.use_24h();
    let presets: &[f64] = if draft.all_day { &steps::ALL_DAY_REMINDERS } else { &steps::TIMED_REMINDERS };
    let mut chips = row().key("draft-reminders").gap(rem(0.25)).flex_wrap();
    chips = chips.child(chip(p, "reminder-default", "Default".into(), draft.reminders.is_none()).on_press(|s: &mut State| {
        if let Some(d) = s.draft.as_mut() {
            d.reminders = None;
        }
    }));
    chips = chips.child(chip(p, "reminder-none", "None".into(), draft.reminders.as_deref() == Some(&[])).on_press(|s: &mut State| {
        if let Some(d) = s.draft.as_mut() {
            d.reminders = Some(Vec::new());
        }
    }));
    // Presets, plus any other reminder the event already has, so it can be turned off.
    let mut shown: Vec<f64> = presets.to_vec();
    for m in draft.reminders.iter().flatten() {
        if !shown.contains(m) {
            shown.push(*m);
        }
    }
    shown.sort_by(f64::total_cmp);
    for minutes in shown {
        let on = draft.reminders.as_ref().is_some_and(|r| r.contains(&minutes));
        let label = short_reminder(minutes, draft.all_day, use_24h);
        chips = chips.child(chip(p, &format!("reminder-{minutes}"), label, on).on_press(move |s: &mut State| {
            if let Some(d) = s.draft.as_mut() {
                d.reminders = steps::toggle_reminder(&d.reminders, minutes);
            }
        }));
    }
    labelled(p, "draft-reminder", &NOTIFICATION_03, chips)
}

/// "10 min before" without the "before": the row already says what these are.
fn short_reminder(minutes: f64, all_day: bool, use_24h: bool) -> String {
    let label = detail::reminder_label(minutes, all_day, use_24h);
    label.replace(" before", "")
}

pub(super) fn chip(p: &Paint, key: &str, label: String, on: bool) -> El {
    row()
        .key(key.to_string())
        .role("checkbox")
        .label(label.clone())
        .checked(on)
        .focusable(true)
        .px(rem(0.5))
        .py(rem(0.1875))
        .radius(theme::RADIUS_LG)
        .fill(if on { p.foreground } else { fade(p.foreground, 0.05) })
        .hover(if on { p.foreground } else { p.accent })
        .press_scale(0.96)
        .cursor(Cursor::Pointer)
        .child(text(label).font(theme::TEXT_XS).color(if on { p.background } else { p.foreground }))
}

/// A row with a muted 18px glyph beside its content, as the detail panel's rows.
pub(super) fn labelled(p: &Paint, key: &str, glyph: &'static Icon, content: El) -> El {
    row()
        .key(key.to_string())
        .w_full()
        .gap(rem(0.75))
        .child(row().key("glyph").h(ARROW).center_y().child(icon(glyph, rem(1.125)).color(p.muted_foreground)))
        .child(col().key("content").grow(1.0).min_w(0.0).justify_center().min_h(ARROW).child(content))
}
