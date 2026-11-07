//! The form's Repeat row (`calendar/repeat-control.tsx`): the rule's summary, which opens the
//! presets as chips and a custom editor under them: every N days, weeks, months or years, the
//! weekdays of a weekly rule, and when it ends. A repeating instance can't change its rule
//! (synced events never carry one), so it just says so.

use chrono::{Months, NaiveDate};
use rune::{Cursor, El, col, row, text};

use super::event_create::{chip, labelled, stepper};
use crate::app::{Draft, FormMenu, State};
use crate::data::days::{today, working_zone};
use crate::data::rrule::{self, End, Freq, Recurrence};
use crate::ui::components::icons_gen::REPEAT;
use crate::ui::components::segmented::segmented;
use crate::ui::theme::{self, Paint, fade, rem};

const DAY: f32 = rem(1.75);

pub fn repeat_row(s: &State, p: &Paint, draft: &Draft) -> El {
    let fixed = draft.editing.as_ref().is_some_and(|e| e.provider_series_id.is_some());
    let label = match &draft.recurrence {
        Some(r) => r.summary(),
        None if fixed => "Part of a repeating series".to_string(),
        None => "Does not repeat".to_string(),
    };
    let summary = text(label).font(theme::TEXT_SM).color(if draft.recurrence.is_some() { p.foreground } else { p.muted_foreground }).truncate();
    if fixed {
        return labelled(p, "draft-repeat", &REPEAT, summary);
    }
    let trigger = row()
        .key("draft-repeat-trigger")
        .role("button")
        .label("Repeat")
        .focusable(true)
        // The hover pad reaches out past the text, which lines up with the other rows.
        .ml(-rem(0.375))
        .px(rem(0.375))
        .py(rem(0.125))
        .radius(theme::RADIUS_LG)
        .hover(p.accent)
        .cursor(Cursor::Pointer)
        .child(summary)
        .on_press(|s: &mut State| toggle_menu(s, FormMenu::Repeat));
    let mut content = col().key("draft-repeat-col").w_full().gap(rem(0.5)).child(row().key("draft-repeat-line").child(trigger));
    if draft.menu == Some(FormMenu::Repeat) {
        content = content.child(menu(s, p, draft));
    }
    labelled(p, "draft-repeat", &REPEAT, content)
}

pub fn toggle_menu(s: &mut State, menu: FormMenu) {
    if let Some(d) = s.draft.as_mut() {
        d.menu = if d.menu == Some(menu) { None } else { Some(menu) };
    }
}

fn edit_rule(s: &mut State, f: impl FnOnce(&mut Recurrence, f64, chrono_tz::Tz)) {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    if let Some(d) = s.draft.as_mut() {
        // Any custom edit turns repeating on, from weekly on the start's day.
        let mut rule = d.recurrence.clone().unwrap_or_else(|| Recurrence::weekly_on(d.start_ms, zone));
        f(&mut rule, d.start_ms, zone);
        d.recurrence = Some(rule);
    }
}

fn menu(s: &State, p: &Paint, draft: &Draft) -> El {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let mut presets = row().key("repeat-presets").gap(rem(0.25)).flex_wrap();
    presets = presets.child(chip(p, "repeat-never", "None".into(), draft.recurrence.is_none()).on_press(|s: &mut State| {
        if let Some(d) = s.draft.as_mut() {
            d.recurrence = None;
        }
    }));
    for (i, (label, rule)) in rrule::presets(draft.start_ms, zone).into_iter().enumerate() {
        let on = draft.recurrence.as_ref().is_some_and(|r| r.is(&rule));
        presets = presets.child(chip(p, &format!("repeat-preset-{i}"), label.into(), on).on_press(move |s: &mut State| {
            if let Some(d) = s.draft.as_mut() {
                d.recurrence = Some(rule.clone());
            }
        }));
    }

    let rule = draft.recurrence.clone().unwrap_or_else(|| Recurrence::weekly_on(draft.start_ms, zone));
    let freq = Freq::ALL.iter().position(|f| *f == rule.freq).unwrap_or(1);
    let options: Vec<(String, &str)> = Freq::ALL.iter().map(|f| (format!("freq-{}", f.label().to_lowercase()), f.label())).collect();
    let options: Vec<(&str, &str)> = options.iter().map(|(k, l)| (k.as_str(), *l)).collect();
    let every = row()
        .key("repeat-every")
        .gap(rem(0.5))
        .center_y()
        .child(text("Every").font(theme::TEXT_SM).color(p.muted_foreground))
        .child(stepper(p, "repeat-interval", rule.interval.to_string(), |s: &mut State, dir| {
            edit_rule(s, |r, _, _| r.interval = (r.interval as i64 + dir).max(1) as u32)
        }))
        .child(segmented(p, "repeat-freq", &options, freq, |i| {
            Box::new(move |s: &mut State| edit_rule(s, |r, start, zone| r.set_freq(Freq::ALL[i], start, zone)))
        }));

    let mut custom = col().key("repeat-custom").w_full().gap(rem(0.5)).child(every);
    if rule.freq == Freq::Weekly {
        let mut days = row().key("repeat-weekdays").gap(rem(0.25));
        for (i, initial) in rrule::WEEKDAY_INITIALS.iter().enumerate() {
            let on = draft.recurrence.as_ref().is_some_and(|r| r.weekdays.contains(&i));
            days = days.child(
                row()
                    .key(format!("weekday-{}", rrule::WEEKDAYS[i]))
                    .role("checkbox")
                    .label(rrule::WEEKDAYS[i])
                    .checked(on)
                    .focusable(true)
                    .size(DAY, DAY)
                    .radius(DAY / 2.0)
                    .center()
                    .fill(if on { p.primary } else { fade(p.foreground, 0.05) })
                    .hover(if on { p.primary } else { p.accent })
                    .press_scale(0.92)
                    .cursor(Cursor::Pointer)
                    .child(text(*initial).font(theme::TEXT_XS).color(if on { p.primary_foreground } else { p.muted_foreground }))
                    .on_press(move |s: &mut State| edit_rule(s, |r, _, _| r.toggle_weekday(i))),
            );
        }
        custom = custom.child(days);
    }

    let end_index = match draft.recurrence.as_ref().map(|r| r.end) {
        Some(End::OnDate(_)) => 1,
        Some(End::Count(_)) => 2,
        _ => 0,
    };
    let first_day = today(draft.start_ms, zone);
    let mut ends = row()
        .key("repeat-end")
        .gap(rem(0.5))
        .center_y()
        .child(text("Ends").font(theme::TEXT_SM).color(p.muted_foreground))
        .child(segmented(p, "repeat-end-kind", &[("end-never", "Never"), ("end-date", "On date"), ("end-count", "After")], end_index, move |i| {
            Box::new(move |s: &mut State| {
                edit_rule(s, |r, _, _| {
                    r.end = match i {
                        1 => End::OnDate(first_day.checked_add_months(Months::new(1)).unwrap_or(first_day)),
                        2 => End::Count(5),
                        _ => End::Never,
                    }
                })
            })
        }));
    match draft.recurrence.as_ref().map(|r| r.end) {
        Some(End::OnDate(day)) => {
            ends = ends.child(stepper(p, "repeat-until", day.format("%b %-d, %Y").to_string(), move |s: &mut State, dir| {
                edit_rule(s, |r, _, _| {
                    if let End::OnDate(day) = &mut r.end {
                        *day = step_day(*day, dir).max(first_day);
                    }
                })
            }))
        }
        Some(End::Count(n)) => {
            ends = ends.child(stepper(p, "repeat-count", format!("{n} time{}", if n == 1 { "" } else { "s" }), |s: &mut State, dir| {
                edit_rule(s, |r, _, _| {
                    if let End::Count(n) = &mut r.end {
                        *n = (*n as i64 + dir).max(1) as u32;
                    }
                })
            }))
        }
        _ => {}
    }
    custom = custom.child(ends);

    col().key("repeat-menu")
        .w_full()
        .gap(rem(0.625))
        .padding(rem(0.5))
        .radius(theme::RADIUS_XL)
        .fill(fade(p.foreground, 0.04))
        .child(presets)
        .child(custom)
}

/// A day forward or back (the stepper's unit for an end date).
fn step_day(day: NaiveDate, dir: i64) -> NaiveDate {
    if dir >= 0 { day.succ_opt().unwrap_or(day) } else { day.pred_opt().unwrap_or(day) }
}
