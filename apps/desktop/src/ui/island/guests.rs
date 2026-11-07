//! The form's Guests row (`calendar/guest-picker.tsx`): "Add guests" opens a search over
//! synced contacts that also invites any typed address; the guests show as chips above it,
//! each removable but the organiser. Up and Down move through the suggestions, Enter adds,
//! Escape closes the search. A guest list the organiser hid, or one you may not change,
//! shows as such.

use rune::tok::TextStyle;
use rune::{Cursor, El, col, icon, row, text, text_input};

use super::event_create::labelled;
use crate::app::{Draft, FormMenu, State};
use crate::data::guests;
use crate::data::models::Attendee;
use crate::data::permissions::Capabilities;
use crate::ui::components::avatar::avatar;
use crate::ui::components::icons_gen::{CANCEL_01, USER_MULTIPLE_02};
use crate::ui::theme::{self, Paint, fade, rem};

pub fn guests_row(s: &State, p: &Paint, draft: &Draft, caps: Option<&Capabilities>) -> El {
    if caps.is_some_and(|c| !c.can_see_guests) {
        return labelled(p, "draft-guests", &USER_MULTIPLE_02, text("Guest list hidden by the organiser").font(theme::TEXT_SM).color(p.muted_foreground));
    }
    let can_invite = caps.is_none_or(|c| c.can_invite_others);
    let mut content = col().key("draft-guests-col").w_full().gap(rem(0.5));
    let trigger_label = match (can_invite, draft.guests.is_empty()) {
        (true, _) => "Add guests",
        (false, true) => "No guests",
        (false, false) => "Guests",
    };
    let mut trigger = row()
        .key("draft-guests-trigger")
        .ml(-rem(0.375))
        .px(rem(0.375))
        .py(rem(0.125))
        .radius(theme::RADIUS_LG)
        .child(text(trigger_label).font(theme::TEXT_SM).color(p.muted_foreground));
    if can_invite {
        trigger = trigger.role("button").label("Add guests").focusable(true).hover(p.accent).cursor(Cursor::Pointer).on_press(open_search);
    }
    content = content.child(row().key("draft-guests-line").child(trigger));
    if !draft.guests.is_empty() {
        let mut chips = row().key("guest-chips").w_full().gap(rem(0.25)).flex_wrap();
        for g in &draft.guests {
            chips = chips.child(guest_chip(p, g, can_invite && g.organizer != Some(true)));
        }
        content = content.child(chips);
    }
    if draft.menu == Some(FormMenu::Guests) {
        content = content.child(search(s, p, draft));
    }
    labelled(p, "draft-guests", &USER_MULTIPLE_02, content)
}

fn open_search(s: &mut State) {
    let Some(d) = s.draft.as_mut() else { return };
    if d.menu == Some(FormMenu::Guests) {
        d.menu = None;
        return;
    }
    d.menu = Some(FormMenu::Guests);
    d.guest_active = 0;
    s.guest_query = rune::TextEdit::new("");
    s.guest_query.focused = true;
    s.draft_title.focused = false;
}

/// Add the highlighted suggestion (or the typed address) and stay in the search.
fn add_active(s: &mut State) {
    let choices = guests::choices(&s.people, &s.guest_query.text, s.draft.as_ref().map_or(&[], |d| &d.guests));
    let Some(d) = s.draft.as_mut() else { return };
    let Some(guest) = choices.get(d.guest_active.min(choices.len().saturating_sub(1))).cloned() else { return };
    add(s, guest);
}

fn add(s: &mut State, guest: Attendee) {
    let Some(d) = s.draft.as_mut() else { return };
    if !d.guests.iter().any(|g| g.email.eq_ignore_ascii_case(&guest.email)) {
        d.guests.push(guest);
    }
    d.guest_active = 0;
    s.guest_query = rune::TextEdit::new("");
    s.guest_query.focused = true;
}

fn search(s: &State, p: &Paint, draft: &Draft) -> El {
    let choices = guests::choices(&s.people, &s.guest_query.text, &draft.guests);
    let input = text_input(&s.guest_query, TextStyle::new(rem(0.875), 400.0))
        .key("guest-search")
        .single_line()
        .placeholder("Search or type an email", p.muted_foreground)
        .color(p.foreground)
        .w_full()
        .px(rem(0.625))
        .py(rem(0.375))
        .radius(theme::RADIUS_LG)
        .fill(fade(p.foreground, 0.06))
        .on_edit(|s: &mut State| {
            if let Some(d) = s.draft.as_mut() {
                d.guest_active = 0;
            }
            &mut s.guest_query
        })
        .on_submit(|s: &mut State, _tx| add_active(s))
        .on_input_key(move |s: &mut State, e: &rune::KeyEvent, _tx: &mut rune::Tx| {
            let count = guests::choices(&s.people, &s.guest_query.text, s.draft.as_ref().map_or(&[], |d| &d.guests)).len();
            let Some(d) = s.draft.as_mut() else { return false };
            match e.key {
                rune::Key::Escape => {
                    d.menu = None;
                    s.guest_query.focused = false;
                    true
                }
                rune::Key::Down if count > 0 => {
                    d.guest_active = (d.guest_active + 1) % count;
                    true
                }
                rune::Key::Up if count > 0 => {
                    d.guest_active = (d.guest_active + count - 1) % count;
                    true
                }
                _ => false,
            }
        });

    let mut list = col().key("guest-suggestions").w_full().gap(rem(0.125));
    if choices.is_empty() {
        let hint = if s.guest_query.text.trim().is_empty() { "Search contacts or type an email" } else { "No matches — type a full email to invite" };
        list = list.child(text(hint).font(theme::TEXT_XS).color(p.muted_foreground).px(rem(0.5)).py(rem(0.375)));
    }
    for (i, guest) in choices.into_iter().enumerate() {
        let active = i == draft.guest_active;
        // The typed address, not a contact: "Invite …".
        let invite = !s.people.iter().any(|c| c.email.eq_ignore_ascii_case(&guest.email));
        let name = guest.display_name.clone();
        let mut lines = col().key("lines").min_w(0.0).grow(1.0);
        if invite {
            lines = lines.child(text(format!("Invite {}", guest.email)).font(theme::TEXT_SM).color(p.foreground).truncate());
        } else {
            if let Some(n) = &name {
                lines = lines.child(text(n.clone()).font(theme::TEXT_SM).color(p.foreground).truncate());
            }
            lines = lines.child(text(guest.email.clone()).font(theme::TEXT_XS).color(p.muted_foreground).truncate());
        }
        let key = format!("suggest-{i}");
        list = list.child(
            row()
                .key(key)
                .role("option")
                .label(guest.email.clone())
                .w_full()
                .gap(rem(0.5))
                .center_y()
                .px(rem(0.5))
                .py(rem(0.25))
                .radius(theme::RADIUS_LG)
                .fill(if active { p.accent } else { rune::Color::TRANSPARENT })
                .hover(p.accent)
                .cursor(Cursor::Pointer)
                .child(avatar("avatar", &guest.email, name.as_deref(), rem(1.5)))
                .child(lines)
                .on_press(move |s: &mut State| add(s, guest.clone())),
        );
    }
    col().key("guest-menu").w_full().gap(rem(0.375)).padding(rem(0.375)).radius(theme::RADIUS_XL).fill(fade(p.foreground, 0.04)).child(list).child(input)
}

fn guest_chip(p: &Paint, g: &Attendee, removable: bool) -> El {
    let mut chip = row()
        .key(format!("guest-{}", g.email))
        .gap(rem(0.375))
        .center_y()
        .pl(rem(0.125))
        .pr(rem(if removable { 0.125 } else { 0.5 }))
        .py(rem(0.125))
        .radius(rem(1.0))
        .fill(fade(p.foreground, 0.06))
        .child(avatar("avatar", &g.email, g.display_name.as_deref(), rem(1.25)))
        .child(text(g.name().to_string()).font(theme::TEXT_XS).color(p.foreground).truncate());
    if removable {
        let email = g.email.clone();
        chip = chip.child(
            row()
                .key("remove")
                .role("button")
                .label(format!("Remove {}", g.name()))
                .focusable(true)
                .size(rem(1.25), rem(1.25))
                .center()
                .radius(rem(0.625))
                .hover(p.accent)
                .cursor(Cursor::Pointer)
                .child(icon(&CANCEL_01, rem(0.75)).color(p.muted_foreground))
                .on_press(move |s: &mut State| {
                    if let Some(d) = s.draft.as_mut() {
                        d.guests.retain(|g| g.email != email);
                    }
                }),
        );
    }
    chip
}
