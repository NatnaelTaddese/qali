//! Named states for headless snapshots (`--snap out.png --scene signed-in`) and tests. A fixed
//! Monday in New York, so the labels and times never depend on when the snapshot runs.

use chrono::{NaiveDate, TimeZone};

use crate::app::{Phase, State};
use crate::auth::SessionUser;
use crate::data::days;
use crate::data::models::{Attendee, CalendarEvent, CalendarListItem, Person, Reminder, StoredPreferences};

pub const SCENES: &[(&str, fn(&mut State))] = &[
    ("loader", |s| s.phase = Phase::Restoring),
    ("signed-out", |s| s.phase = Phase::SignedOut),
    ("error", |s| {
        s.phase = Phase::SignedOut;
        s.error = Some("Sign-in failed (state_mismatch).".into());
    }),
    ("waiting", |s| s.phase = Phase::Waiting),
    ("loading", |s| {
        signed_in(s);
        s.loaded = false;
    }),
    ("empty", |s| {
        signed_in(s);
        s.events.clear();
    }),
    ("signed-in", signed_in),
    ("day", |s| {
        signed_in(s);
        s.view = crate::data::page::View::Day;
    }),
    ("event", |s| {
        signed_in(s);
        let review = s.events.iter().find(|e| e.id == "review").cloned().unwrap();
        s.open_event(review);
    }),
    ("event-guests", |s| {
        signed_in(s);
        let review = s.events.iter().find(|e| e.id == "review").cloned().unwrap();
        s.open_event(review);
        s.guests_expanded = true;
    }),
    ("account", |s| {
        signed_in(s);
        s.island = crate::app::Island::Account;
    }),
    ("month", |s| {
        signed_in(s);
        s.view = crate::data::page::View::Month;
    }),
];

const ZONE: chrono_tz::Tz = chrono_tz::America::New_York;

fn local(y: i32, m: u32, d: u32, h: u32, min: u32) -> f64 {
    ZONE.with_ymd_and_hms(y, m, d, h, min, 0).unwrap().timestamp_millis() as f64
}

fn utc_midnight(y: i32, m: u32, d: u32) -> f64 {
    chrono::Utc.with_ymd_and_hms(y, m, d, 0, 0, 0).unwrap().timestamp_millis() as f64
}

fn event(id: &str, summary: &str, start_ms: f64, end_ms: f64, all_day: bool, color: Option<&str>, location: Option<&str>) -> CalendarEvent {
    CalendarEvent {
        id: id.into(),
        start_ms,
        end_ms,
        all_day,
        summary: Some(summary.into()),
        location: location.map(Into::into),
        status: "confirmed".into(),
        color: color.map(Into::into),
        local_calendar_id: Some("cal-work".into()),
        user_id: Some("u1".into()),
        ..Default::default()
    }
}

fn guest(email: &str, name: &str, status: &str) -> Attendee {
    Attendee { email: email.into(), display_name: Some(name.into()), response_status: Some(status.into()), ..Default::default() }
}

/// The design review the detail scenes open: a Meet link, guests in every state, a
/// location, a description and a reminder, with you invited but not the organizer.
fn design_review(start_ms: f64, end_ms: f64) -> CalendarEvent {
    CalendarEvent {
        description: Some("<p>Walk through the <b>desktop home</b> directions and pick one.</p><p>Bring screenshots of the week grid.</p>".into()),
        html_link: Some("https://www.google.com/calendar/event?eid=ZGVzaWduLXJldmlldw".into()),
        conference_url: Some("https://meet.google.com/qal-desk-top".into()),
        conference_type: Some("hangoutsMeet".into()),
        organizer: Some(Person { email: Some("sara@example.com".into()), display_name: Some("Sara Kim".into()), is_self: Some(false) }),
        attendees: Some(vec![
            Attendee { organizer: Some(true), ..guest("sara@example.com", "Sara Kim", "accepted") },
            guest("tomas@example.com", "Tomas Ruiz", "accepted"),
            guest("ana@example.com", "Ana Silva", "tentative"),
            guest("lee@example.com", "Lee Park", "declined"),
            Attendee { is_self: Some(true), ..guest("alex@example.com", "Alex Rivera", "needsAction") },
            guest("kai@example.com", "Kai Moreau", "needsAction"),
            guest("noor@example.com", "Noor Haddad", "accepted"),
        ]),
        reminders: Some(vec![Reminder { method: "popup".into(), minutes: 10.0 }]),
        ..event("review", "Design review", start_ms, end_ms, false, Some("6"), Some("Studio 3, 2nd floor"))
    }
}

pub fn signed_in(s: &mut State) {
    s.phase = Phase::SignedIn;
    s.user = Some(SessionUser { id: "u1".into(), name: "Alex Rivera".into(), email: "alex@example.com".into(), image: None });
    s.prefs = StoredPreferences { time_zone: Some("America/New_York".into()), ..Default::default() };
    s.calendar_colors = [("cal-work".to_string(), "#039be5".to_string())].into();
    s.calendars = vec![CalendarListItem {
        id: "cal-work".into(),
        summary: Some("Work".into()),
        background_color: Some("#039be5".into()),
        access_role: Some("owner".into()),
        primary: Some(true),
        ..Default::default()
    }];
    let monday = NaiveDate::from_ymd_opt(2026, 11, 9).unwrap();
    s.window = (days::start_of_day_ms(monday, ZONE), days::start_of_day_ms(monday + chrono::Duration::days(7), ZONE));
    s.now_ms = local(2026, 11, 11, 14, 35);
    s.clock_pinned = true;
    s.scroll_to_now = true;
    let l = local;
    let mut events = Vec::new();
    for (i, d) in (9..=13).enumerate() {
        events.push(event(&format!("standup-{i}"), "Standup", l(2026, 11, d, 9, 0), l(2026, 11, d, 9, 15), false, Some("2"), None));
    }
    events.extend([
        event("deep-mon", "Deep work", l(2026, 11, 9, 10, 0), l(2026, 11, 9, 12, 0), false, Some("9"), None),
        event("lunch", "Lunch with Sara", l(2026, 11, 9, 12, 30), l(2026, 11, 9, 13, 30), false, Some("5"), Some("Blue Bottle")),
        event("ana", "1:1 Ana", l(2026, 11, 10, 13, 0), l(2026, 11, 10, 13, 30), false, Some("7"), None),
        event("spike", "Desktop app spike", l(2026, 11, 10, 14, 30), l(2026, 11, 10, 16, 0), false, Some("1"), None),
        // A cascade: the call starts an hour into deep work, so it indents on top of it.
        event("deep-wed", "Deep work", l(2026, 11, 11, 10, 0), l(2026, 11, 11, 12, 0), false, Some("9"), None),
        event("call", "Vendor call", l(2026, 11, 11, 11, 0), l(2026, 11, 11, 11, 30), false, Some("11"), None),
        // A tile: two starts 30 minutes apart split the column.
        design_review(l(2026, 11, 11, 15, 0), l(2026, 11, 11, 16, 0)),
        event("hiring", "Hiring sync", l(2026, 11, 11, 15, 30), l(2026, 11, 11, 16, 30), false, Some("3"), None),
        event("dentist", "Dentist", l(2026, 11, 12, 10, 0), l(2026, 11, 12, 11, 0), false, Some("11"), None),
        event("lunch-thu", "Lunch", l(2026, 11, 12, 12, 30), l(2026, 11, 12, 13, 30), false, Some("6"), None),
        event("tomas", "1:1 Tomas", l(2026, 11, 12, 16, 0), l(2026, 11, 12, 16, 30), false, Some("7"), None),
        event("planning", "Quarterly planning", l(2026, 11, 13, 14, 0), l(2026, 11, 13, 15, 30), false, Some("4"), None),
        event("climb", "Climbing", l(2026, 11, 14, 10, 30), l(2026, 11, 14, 12, 30), false, Some("10"), Some("Brooklyn Boulders")),
        // Overnight: shows on Saturday's evening and Sunday's early hours.
        event("flight", "Red-eye to SFO", l(2026, 11, 14, 22, 0), l(2026, 11, 15, 1, 30), false, Some("8"), None),
        event("family", "Family call", l(2026, 11, 15, 18, 0), l(2026, 11, 15, 19, 0), false, Some("3"), None),
        event("offsite", "Offsite", utc_midnight(2026, 11, 12), utc_midnight(2026, 11, 14), true, Some("2"), None),
        event("pto", "Ana out", utc_midnight(2026, 11, 10), utc_midnight(2026, 11, 13), true, Some("7"), None),
        event("bday", "Sara's birthday", utc_midnight(2026, 11, 12), utc_midnight(2026, 11, 13), true, Some("4"), None),
    ]);
    s.events = events;
    s.loaded = true;
}
