//! The event panel (`calendar/event-detail.tsx`): the colour strip and title with the calendar
//! and Busy/Free under it, then rows for the time, reminders, series, video call, place,
//! guests and description, the RSVP switch when you're invited, and the link actions.
//! Edit, duplicate and delete arrive with phase 4.

use std::time::{Duration, Instant};

use rune::tok::TextStyle;
use rune::{ClipboardContent, Color, Cursor, El, Icon, Tx, col, el, icon, oklch, row, text};

use crate::app::{self, State};
use crate::data::colors;
use crate::data::days::working_zone;
use crate::data::detail::{self, Rsvp, group_guests, rsvp_summary};
use crate::data::models::CalendarEvent;
use crate::data::permissions::capabilities;
use crate::ui::components::avatar::avatar;
use crate::ui::components::icons_gen::*;
use crate::ui::theme::{self, Paint, rem};

const MAX_AVATARS: usize = 6;
const COPIED_FOR: Duration = Duration::from_millis(1500);
const RSVP_CHOICES: [(&str, &str); 3] = [("accepted", "Going"), ("tentative", "Maybe"), ("declined", "No")];

pub fn event_detail(s: &State, p: &Paint, e: &CalendarEvent) -> El {
    let zone = working_zone(s.prefs.time_zone.as_deref());
    let use_24h = s.prefs.use_24h();
    let calendar = s.calendars.iter().find(|c| Some(&c.id) == e.local_calendar_id.as_ref());
    let caps = capabilities(e, calendar);
    let hue = theme::event_color(colors::event_swatch(e, &s.calendar_colors));

    let mut panel = col().key("event-detail").w_full().gap(rem(0.75)).child(header(s, p, e, calendar.map(|c| (c.display_name(), c.background_color.as_deref())), hue));

    panel = panel.child(detail_row(
        p,
        "time",
        &CLOCK_01,
        col().child(text(detail::time_text(e, zone, use_24h)).font(theme::TEXT_SM_MEDIUM).color(p.foreground)).child(
            text(detail::relative(e.start_ms, s.now_ms)).font(theme::TEXT_XS).color(p.muted_foreground),
        ),
    ));

    if e.user_id.is_some()
        && let Some(reminders) = &e.reminders
    {
        let popups: Vec<String> = reminders.iter().filter(|r| r.method == "popup").map(|r| detail::reminder_label(r.minutes, e.all_day, use_24h)).collect();
        let label = if popups.is_empty() { "No reminders".to_string() } else { popups.join(" · ") };
        panel = panel.child(detail_row(p, "reminders", &ALARM_CLOCK, muted(p, label)));
    }
    if e.provider_series_id.is_some() {
        panel = panel.child(detail_row(p, "series", &REPEAT, muted(p, "Part of a repeating series".into())));
    }
    if let Some(url) = &e.conference_url {
        panel = panel.child(conference(s, p, e, url));
    }
    if let Some(location) = e.location.as_deref().filter(|l| !l.trim().is_empty()) {
        let url = detail::location_url(location);
        panel = panel.child(detail_row(
            p,
            "location",
            &LOCATION_01,
            text(location.to_string())
                .key("location-link")
                .role("link")
                .font(theme::TEXT_SM)
                .color(p.muted_foreground)
                .wrap()
                .cursor(Cursor::Pointer)
                .on_press_tx(move |_: &mut State, tx: &mut Tx| {
                    let _ = tx.open_url(&url);
                }),
        ));
    }
    if let Some(guests) = e.attendees.as_ref().filter(|g| !g.is_empty()) {
        panel = panel.child(if caps.can_see_guests {
            guest_section(s, p, guests)
        } else {
            detail_row(p, "guests", &USER_MULTIPLE_02, muted(p, "Guest list hidden by the organiser".into()))
        });
    }
    if let Some(description) = e.description.as_deref().map(detail::preview_text).filter(|d| !d.is_empty()) {
        panel = panel.child(detail_row(
            p,
            "description",
            &TEXT_ALIGN_LEFT_01,
            text(description)
                .key("description-text")
                .role("button")
                .label("Description")
                .font(theme::TEXT_SM)
                .color(p.muted_foreground)
                .wrap()
                .max_lines(if s.description_expanded { 0 } else { 4 })
                .cursor(Cursor::Pointer)
                .on_press(|s: &mut State| s.description_expanded = !s.description_expanded),
        ));
    }
    if caps.can_respond {
        let pending = s.rsvp_pending.as_ref().filter(|(id, _)| *id == e.id).map(|(_, st)| st.as_str());
        panel = panel.child(rsvp(p, &e.id, pending.or(caps.self_response.as_deref())));
    }
    panel.child(footer(s, p, e))
}

/// The colour strip, title, calendar · Busy/Free (and a lock when private), and close.
fn header(s: &State, p: &Paint, e: &CalendarEvent, calendar: Option<(&str, Option<&str>)>, hue: Color) -> El {
    let mut meta = row().key("meta").gap(rem(0.375)).center_y();
    if let Some((name, color)) = calendar {
        let dot = color.map(|c| theme::event_color(colors::snap(c))).unwrap_or(hue);
        meta = meta
            .child(el().key("calendar-dot").size(rem(0.5), rem(0.5)).radius(rem(0.25)).fill(dot))
            .child(text(name.to_string()).key("calendar-name").font(theme::TEXT_XS).color(p.muted_foreground).truncate().shrink().min_w(0.0))
            .child(text("·").font(theme::TEXT_XS).color(p.muted_foreground));
    }
    meta = meta.child(text(if e.busy == Some(false) { "Free" } else { "Busy" }).key("busy").font(theme::TEXT_XS).color(p.muted_foreground));
    if e.visibility.as_deref() == Some("private") {
        meta = meta.child(icon(&SQUARE_LOCK_01, rem(0.875)).color(p.muted_foreground));
    }
    let _ = s;
    row()
        .key("header")
        .w_full()
        .gap(rem(0.75))
        .items_stretch()
        .child(el().key("strip").w(3.0).radius(1.5).fill(hue))
        .child(
            col()
                .key("heading")
                .gap(rem(0.125))
                .grow(1.0)
                .min_w(0.0)
                .child(text(e.title().to_string()).key("event-title").font(TextStyle::new(rem(1.0), 600.0)).color(p.foreground).wrap().max_lines(2))
                .child(meta),
        )
        .child(icon_button(p, "close", "Close", &CANCEL_01, rem(1.75), rem(1.0)).self_start().on_press(|s: &mut State| s.close_island()))
}

/// `DetailRow`: a muted 18px icon beside the content, both top-aligned.
fn detail_row(p: &Paint, key: &str, glyph: &'static Icon, content: El) -> El {
    row()
        .key(key.to_string())
        .w_full()
        .gap(rem(0.75))
        .items_start()
        .child(row().key("icon").pt(rem(0.125)).child(icon(glyph, rem(1.125)).color(p.muted_foreground)))
        .child(col().key("content").grow(1.0).min_w(0.0).child(content))
}

fn muted(p: &Paint, label: String) -> El {
    text(label).font(theme::TEXT_SM).color(p.muted_foreground).wrap()
}

/// The video call: Meet's mark (or a video glyph), its name and link, copy, and Join.
fn conference(s: &State, p: &Paint, e: &CalendarEvent, url: &str) -> El {
    let meet = e.conference_type.as_deref() == Some("hangoutsMeet");
    let name = e.conference_name.clone().unwrap_or_else(|| if meet { "Google Meet".into() } else { "Video call".into() });
    let emerald = if p.dark { oklch(0.696, 0.17, 162.48) } else { oklch(0.596, 0.145, 163.225) };
    let mark: El = match s.images.as_ref().and_then(|i| i.meet.as_ref()) {
        Some(image) if meet => el().key("meet-mark").size(rem(1.125), rem(1.125)).pixels(image.pixels()),
        _ => icon(&VIDEO_01, rem(1.125)).color(emerald),
    };
    let shown = url.trim_start_matches("https://").trim_start_matches("http://").to_string();
    let join_url = url.to_string();
    let copy_url = url.to_string();
    // The web's `Button size="sm"` in emerald: a pill with the video glyph.
    let join = row()
        .key("join")
        .role("link")
        .label(format!("Join {name}"))
        .focusable(true)
        .h(rem(2.0))
        .px(rem(0.75))
        .gap(rem(0.25))
        .center()
        .radius(theme::RADIUS_4XL)
        .fill(emerald)
        .hover(theme::white(0.1))
        .press_scale(0.97)
        .cursor(Cursor::Pointer)
        .child(icon(&VIDEO_01, rem(1.0)).color(Color::WHITE))
        .child(text("Join").font(theme::TEXT_SM_MEDIUM).color(Color::WHITE))
        .on_press_tx(move |_: &mut State, tx: &mut Tx| {
            let _ = tx.open_url(&join_url);
        });
    row()
        .key("conference")
        .w_full()
        .gap(rem(0.75))
        .center_y()
        .child(mark)
        .child(
            col()
                .key("call")
                .grow(1.0)
                .min_w(0.0)
                .child(text(name.clone()).font(theme::TEXT_SM_MEDIUM).color(p.foreground))
                .child(text(shown).font(theme::TEXT_XS).color(p.muted_foreground).truncate()),
        )
        .child(copy_button(s, p, "copy-call", &format!("Copy {name} link"), copy_url))
        .child(join)
}

/// Guests as an overlapping avatar stack with RSVP dots and a tally; it expands into the
/// grouped list.
fn guest_section(s: &State, p: &Paint, guests: &[crate::data::models::Attendee]) -> El {
    let ring = theme::mix(p.background, p.card, 0.5);
    let mut stack = row().key("stack").center_y();
    for (i, g) in guests.iter().take(MAX_AVATARS).enumerate() {
        let dot = rsvp_color(p, Rsvp::of(g.response_status.as_deref()));
        stack = stack.child(
            el().key(format!("guest-{i}"))
                .ml(if i == 0 { 0.0 } else { -rem(0.375) })
                .padding(2.0)
                .radius(rem(0.75) + 2.0)
                .fill(ring)
                .child(avatar("avatar", &g.email, g.display_name.as_deref(), rem(1.5)))
                .child(el().key("rsvp-dot").size(rem(0.625), rem(0.625)).radius(rem(0.3125)).fill(dot).border(2.0, ring).pin(None, None, Some(0.0), Some(0.0))),
        );
    }
    if guests.len() > MAX_AVATARS {
        stack = stack.child(
            row()
                .key("overflow")
                .ml(-rem(0.375))
                .size(rem(1.5) + 4.0, rem(1.5) + 4.0)
                .center()
                .radius(rem(0.75) + 2.0)
                .fill(p.muted)
                .border(2.0, ring)
                .child(text(format!("+{}", guests.len() - MAX_AVATARS)).font(TextStyle::new(rem(0.625), 600.0)).color(p.muted_foreground)),
        );
    }
    let mut content = col().key("guests").gap(rem(0.375)).child(
        col()
            .key("guest-toggle")
            .role("button")
            .label(if s.guests_expanded { "Hide guests" } else { "Show guests" })
            .gap(rem(0.375))
            .cursor(Cursor::Pointer)
            .child(stack)
            .child(text(rsvp_summary(guests)).key("rsvp-summary").font(theme::TEXT_XS).color(p.muted_foreground))
            .on_press(|s: &mut State| s.guests_expanded = !s.guests_expanded),
    );
    if s.guests_expanded {
        let mut list = col().key("guest-list").w_full().gap(rem(0.75)).pt(rem(0.25));
        for (rsvp, members) in group_guests(guests) {
            let mut group = col()
                .key(format!("group-{}", rsvp.label()))
                .gap(rem(0.125))
                .child(text(format!("{} {}", members.len(), rsvp.label())).font(TextStyle::new(rem(0.75), 500.0)).color(p.foreground).px(rem(0.25)));
            for g in members {
                let mut who = col().key("who").grow(1.0).min_w(0.0).child(text(g.name().to_string()).font(theme::TEXT_SM).color(p.foreground).truncate());
                if g.display_name.is_some() {
                    who = who.child(text(g.email.clone()).font(theme::TEXT_XS).color(p.muted_foreground).truncate());
                }
                if g.organizer == Some(true) {
                    who = who.child(text("Organiser").font(theme::TEXT_XS).color(p.muted_foreground));
                }
                group = group.child(
                    row()
                        .key(format!("row-{}", g.email))
                        .w_full()
                        .gap(rem(0.5))
                        .px(rem(0.25))
                        .py(rem(0.25))
                        .center_y()
                        .child(avatar("avatar", &g.email, g.display_name.as_deref(), rem(1.75)))
                        .child(who),
                );
            }
            list = list.child(group);
        }
        content = content.child(list.scroll(rune::ScrollSpec { stick_bottom: false }).max_h(rem(14.0)));
    }
    detail_row(p, "guests", &USER_MULTIPLE_02, content)
}

fn rsvp_color(p: &Paint, rsvp: Rsvp) -> Color {
    match rsvp {
        Rsvp::Going => theme::event(4),
        Rsvp::Maybe => theme::event(3),
        Rsvp::NotGoing => p.destructive,
        Rsvp::Awaiting => p.muted_foreground,
    }
}

/// "Are you going?" with Going / Maybe / No (`RsvpControl`): the selected one lifts onto the
/// background; choosing sends the answer and shows it at once.
fn rsvp(p: &Paint, event_id: &str, current: Option<&str>) -> El {
    let mut choices = row().key("rsvp-choices").w_full().gap(rem(0.25)).padding(rem(0.25)).radius(theme::RADIUS_XL).fill(p.muted);
    for (status, label) in RSVP_CHOICES {
        let on = current == Some(status);
        let id = event_id.to_string();
        let mut choice = row()
            .key(format!("rsvp-{status}"))
            .role("button")
            .label(label)
            .checked(on)
            .focusable(true)
            .grow(1.0)
            .py(rem(0.375))
            .center()
            .radius(theme::RADIUS_LG)
            .press_scale(0.97)
            .cursor(Cursor::Pointer)
            .child(text(label).font(TextStyle::new(rem(0.875), 600.0)).color(if on { p.foreground } else { p.muted_foreground }))
            .on_press(move |s: &mut State| {
                if s.rsvp_pending.as_ref().map(|(_, st)| st.as_str()) != Some(status) {
                    app::respond(s, id.clone(), status);
                }
            });
        if on {
            choice = choice.fill(p.background).shadow(1.0, 2.0, theme::black(0.08));
        }
        choices = choices.child(choice);
    }
    col().key("rsvp").w_full().gap(rem(0.375)).child(text("Are you going?").font(theme::TEXT_XS).color(p.muted_foreground)).child(choices)
}

/// Copy link and Open in Google Calendar, in the bordered group the web's footer uses.
fn footer(s: &State, p: &Paint, e: &CalendarEvent) -> El {
    let mut group = row().key("link-actions").gap(rem(0.25)).padding(2.0).radius(theme::RADIUS_XL).border(2.0, p.border);
    let Some(link) = e.html_link.clone() else { return row().key("footer") };
    group = group.child(copy_button(s, p, "copy-link", "Copy link", link.clone()));
    group = group.child(icon_button(p, "open-google", "Open in Google Calendar", &LINK_SQUARE_02, rem(2.0), rem(1.125)).on_press_tx(
        move |_: &mut State, tx: &mut Tx| {
            let _ = tx.open_url(&link);
        },
    ));
    row().key("footer").w_full().child(group)
}

/// A copy action whose glyph turns into a tick for a moment after copying.
fn copy_button(s: &State, p: &Paint, key: &'static str, label: &str, value: String) -> El {
    let copied = s.copied.is_some_and(|(k, until)| k == key && Instant::now() < until);
    let glyph: &'static Icon = if copied { &TICK_02 } else if key == "copy-link" { &LINK_01 } else { &COPY_01 };
    icon_button(p, key, if copied { "Copied" } else { label }, glyph, rem(2.0), rem(1.125)).on_press_tx(move |s: &mut State, tx: &mut Tx| {
        tx.copy_rich(ClipboardContent::new(value.clone()));
        s.copied = Some((key, Instant::now() + COPIED_FOR));
        tx.wake_after(COPIED_FOR);
    })
}

/// A round, muted glyph button that takes the accent on hover (`IconAction`, close).
fn icon_button(p: &Paint, key: &str, label: &str, glyph: &'static Icon, size: f32, glyph_size: f32) -> El {
    row()
        .key(key.to_string())
        .role("button")
        .label(label.to_string())
        .focusable(true)
        .size(size, size)
        .center()
        .radius(theme::RADIUS_LG)
        .hover(p.accent)
        .press_scale(0.94)
        .cursor(Cursor::Pointer)
        .child(icon(glyph, glyph_size).color(p.muted_foreground))
}
