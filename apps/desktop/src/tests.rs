//! Headless runs of the real view: each state renders what it should, and the buttons move
//! between states. Services aren't installed here, so no network is touched.

use rune::{Env, Runtime};

use crate::app::{Phase, State};
use crate::ui::{scenes, views::view};

fn runtime(scene: impl FnOnce(&mut State)) -> Runtime<State> {
    let mut state = State::default();
    scene(&mut state);
    let mut rt = Runtime::new(state, view, crate::ui::views::WINDOW, Env { system_dark: false, scale: 2.0 });
    rt.on_key = Some(crate::app::on_key);
    rt.poll = Some(crate::app::poll);
    rt.frame(0.0);
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
    rt
}

fn press(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("no {key} on screen"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
}

#[test]
fn continue_with_google_waits_for_the_browser_and_cancel_returns() {
    let mut rt = runtime(|s| s.phase = Phase::SignedOut);
    assert!(rt.find("sign-in-card").is_some() && rt.find("terms").is_some());
    press(&mut rt, "google");
    assert_eq!(rt.state.phase, Phase::Waiting);
    assert!(rt.find("spinner").is_some(), "the button spins while the browser is out");
    assert!(rt.find("terms").is_none(), "and Cancel takes the terms line's place");
    press(&mut rt, "cancel");
    assert_eq!(rt.state.phase, Phase::SignedOut);
    assert!(rt.find("spinner").is_none());
}

#[test]
fn a_pressed_button_does_nothing_while_waiting() {
    let mut rt = runtime(|s| s.phase = Phase::Waiting);
    press(&mut rt, "google");
    assert_eq!(rt.state.phase, Phase::Waiting);
}

#[test]
fn the_loader_shows_while_the_session_is_checked() {
    let rt = runtime(|s| s.phase = Phase::Restoring);
    assert!(rt.find("chroma-q").is_some());
}

#[test]
fn ghost_events_need_the_sm_width() {
    let wide = runtime(|s| s.phase = Phase::SignedOut);
    assert!(wide.find("ghost-Standup").is_some());
    let mut state = State::default();
    state.phase = Phase::SignedOut;
    let mut narrow = Runtime::new(state, view, (520.0, 720.0), Env { system_dark: false, scale: 2.0 });
    for _ in 0..3 {
        narrow.frame(1.0 / 60.0);
    }
    assert!(narrow.find("ghost-Standup").is_none());
    assert!(narrow.find("sign-in-card").is_some());
}

#[test]
fn an_error_shows_in_the_card() {
    let rt = runtime(|s| {
        s.phase = Phase::SignedOut;
        s.error = Some("Sign-in failed (access_denied).".into());
    });
    assert!(rt.find("error").is_some());
}

fn rect(rt: &Runtime<State>, key: &str) -> [f32; 4] {
    rt.presented(key).unwrap_or_else(|| panic!("{key} isn't on screen")).0
}

#[test]
fn the_week_shows_seven_equal_days_with_today_marked() {
    let rt = runtime(scenes::signed_in);
    let widths: Vec<f32> = (9..=15).map(|d| rect(&rt, &format!("day-2026-11-{d:02}"))[2]).collect();
    assert!(widths.iter().all(|w| (w - widths[0]).abs() < 0.5), "{widths:?}");
    assert!((widths[0] * 7.0 - (crate::ui::views::WINDOW.0 - crate::ui::calendar::GUTTER_W)).abs() < 2.0);
    assert!(rt.find("today-dot").is_some());
    assert!(rt.find("now-pill").is_some() && rt.find("now-today").is_some());
}

#[test]
fn a_staggered_overlap_cascades_and_a_close_one_tiles() {
    let rt = runtime(scenes::signed_in);
    let (deep, call) = (rect(&rt, "event-deep-wed"), rect(&rt, "event-call"));
    assert!(call[0] > deep[0] + 10.0, "the later call indents past deep work");
    assert!((call[0] + call[2] - (deep[0] + deep[2])).abs() < 0.5, "both end at the column's right edge");
    let (review, hiring) = (rect(&rt, "event-review"), rect(&rt, "event-hiring"));
    assert!((review[2] - hiring[2]).abs() < 0.5, "tiled cards share the width");
    assert!(hiring[0] >= review[0] + review[2], "and sit side by side");
}

#[test]
fn hidden_all_day_lanes_expand_from_the_gutter() {
    let mut rt = runtime(scenes::signed_in);
    assert!(rt.find("all-day-bday").is_none(), "the third lane is folded away");
    press(&mut rt, "all-day-toggle");
    assert!(rt.state.all_day_expanded);
    assert!(rt.find("all-day-bday").is_some());
}

#[test]
fn an_overnight_event_shows_on_both_days() {
    let rt = runtime(scenes::signed_in);
    let sat = rect(&rt, "day-2026-11-14");
    let sun = rect(&rt, "day-2026-11-15");
    let flights: Vec<[f32; 4]> = rt.elements().iter().filter(|e| e.key.as_deref() == Some("event-flight")).map(|e| e.rect).collect();
    assert_eq!(flights.len(), 2, "{flights:?}");
    assert!(flights.iter().any(|r| r[0] >= sat[0] && r[0] < sat[0] + sat[2]));
    assert!(flights.iter().any(|r| r[0] >= sun[0] && r[0] < sun[0] + sun[2]));
}

#[test]
fn sign_out_clears_the_session_state() {
    let mut rt = runtime(scenes::signed_in);
    press(&mut rt, "account-button");
    press(&mut rt, "sign-out");
    assert_eq!(rt.state.phase, Phase::SignedOut);
    assert!(rt.state.events.is_empty() && rt.state.user.is_none());
}

#[test]
fn every_scene_renders() {
    for (name, scene) in scenes::SCENES {
        let rt = runtime(*scene);
        assert!(rt.find("root").is_some(), "{name}");
    }
}

fn key(rt: &mut Runtime<State>, k: rune::Key) {
    rt.key(rune::KeyEvent { key: k, mods: rune::Mods::default() });
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
}

fn text_of(rt: &Runtime<State>, key: &str) -> String {
    rt.elements().into_iter().find(|e| e.key.as_deref() == Some(key)).and_then(|e| e.text).unwrap_or_default()
}

#[test]
fn the_arrows_step_weeks_and_today_comes_back() {
    let mut rt = runtime(scenes::signed_in);
    assert_eq!(text_of(&rt, "title-text"), "November 2026");
    press(&mut rt, "next");
    press(&mut rt, "next");
    press(&mut rt, "next");
    assert_eq!(rt.state.page_start().to_string(), "2026-11-30");
    assert_eq!(text_of(&rt, "title-text"), "Nov – Dec 2026");
    assert!(rt.find("today-dot").is_none(), "today isn't on that page");
    press(&mut rt, "today");
    assert_eq!(rt.state.focus, None);
    assert_eq!(rt.state.page_start().to_string(), "2026-11-09");
    assert!(rt.find("today-dot").is_some());
    press(&mut rt, "previous");
    assert_eq!(rt.state.page_dir, -1);
    assert_eq!(rt.state.page_start().to_string(), "2026-11-02");
}

#[test]
fn keys_switch_views_and_step_pages() {
    let mut rt = runtime(scenes::signed_in);
    key(&mut rt, rune::Key::Text("d".into()));
    assert_eq!(rt.state.view, crate::data::page::View::Day);
    assert_eq!(text_of(&rt, "title-text"), "Wednesday, Nov 11, 2026");
    key(&mut rt, rune::Key::Right);
    assert_eq!(text_of(&rt, "title-text"), "Thursday, Nov 12, 2026");
    key(&mut rt, rune::Key::Text("m".into()));
    assert_eq!(text_of(&rt, "title-text"), "November 2026");
    assert!(rt.find("cell-2026-10-26").is_some(), "the grid starts on the Monday before the 1st");
    key(&mut rt, rune::Key::Text("t".into()));
    key(&mut rt, rune::Key::Text("w".into()));
    assert_eq!(rt.state.page_start().to_string(), "2026-11-09");
}

#[test]
fn a_month_cell_opens_its_day() {
    let mut rt = runtime(|s| {
        scenes::signed_in(s);
        s.view = crate::data::page::View::Month;
    });
    assert!(rt.find("chip-climb").is_some());
    // The cell's date corner: its middle is the Climbing chip, which opens the event instead.
    let cell = rect(&rt, "cell-2026-11-14");
    rt.pointer_down(cell[0] + 12.0, cell[1] + 12.0);
    rt.pointer_up(cell[0] + 12.0, cell[1] + 12.0);
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(rt.state.view, crate::data::page::View::Day);
    assert_eq!(rt.state.page_start().to_string(), "2026-11-14");
    assert!(rt.find("event-climb").is_some());
}

#[test]
fn the_day_view_fans_overlaps_across_its_wide_column() {
    let rt = runtime(|s| {
        scenes::signed_in(s);
        s.view = crate::data::page::View::Day;
    });
    let (deep, call) = (rect(&rt, "event-deep-wed"), rect(&rt, "event-call"));
    assert!(call[0] > deep[0] + deep[2] * 0.4, "lanes, not a 14pt cascade indent");
}

#[test]
fn stepping_past_the_loaded_range_asks_for_a_new_one() {
    let mut s = State::default();
    scenes::signed_in(&mut s);
    s.window = (0.0, 0.0);
    crate::app::follow_page(&mut s);
    let first = s.window;
    assert!(first.1 > first.0);
    s.step(1);
    crate::app::follow_page(&mut s);
    assert_eq!(s.window, first, "next week was loaded with this one");
    s.step(1);
    crate::app::follow_page(&mut s);
    assert!(s.window.0 > first.0, "two weeks on needs a new range");
}

use crate::app::Island;

#[test]
fn an_event_opens_in_the_island_and_esc_closes_it() {
    let mut rt = runtime(scenes::signed_in);
    assert!(rt.find("sync").is_some(), "the island starts as the nav pill");
    press(&mut rt, "event-review");
    assert!(matches!(&rt.state.island, Island::Event(e) if e.id == "review"));
    assert_eq!(text_of(&rt, "event-title"), "Design review");
    assert!(rt.find("join").is_some() && rt.find("rsvp").is_some() && rt.find("location-link").is_some());
    let panel = rect(&rt, "island");
    assert!((panel[2] - crate::ui::theme::rem(27.0)).abs() < 1.0, "the panel takes the event width");
    key(&mut rt, rune::Key::Escape);
    assert_eq!(rt.state.island, Island::Nav);
}

#[test]
fn another_event_swaps_the_panel_and_the_calendar_closes_it() {
    let mut rt = runtime(scenes::signed_in);
    press(&mut rt, "event-review");
    press(&mut rt, "event-dentist");
    assert!(matches!(&rt.state.island, Island::Event(e) if e.id == "dentist"));
    assert!(rt.find("rsvp").is_none(), "no invitation to answer on your own event");
    // An empty spot on the grid: Sunday at 3 PM.
    let sun = rect(&rt, "day-2026-11-15");
    let y = sun[1] + 15.0 * crate::ui::calendar::HOUR_H;
    rt.pointer_down(sun[0] + sun[2] / 2.0, y);
    rt.pointer_up(sun[0] + sun[2] / 2.0, y);
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(rt.state.island, Island::Nav);
}

#[test]
fn answering_shows_at_once_and_guests_expand() {
    let mut rt = runtime(|s| {
        scenes::signed_in(s);
        let review = s.events.iter().find(|e| e.id == "review").cloned().unwrap();
        s.open_event(review);
    });
    assert_eq!(text_of(&rt, "rsvp-summary"), "3 going, 1 maybe, 1 not going, 2 awaiting");
    press(&mut rt, "rsvp-accepted");
    assert_eq!(rt.state.rsvp_pending, Some(("review".into(), "accepted".into())));
    assert!(rt.elements().iter().any(|e| e.key.as_deref() == Some("rsvp-accepted") && e.fill.a > 0.5), "Going lifts onto the background");
    assert!(rt.find("guest-list").is_none());
    press(&mut rt, "guest-toggle");
    assert!(rt.find("guest-list").is_some());
}

#[test]
fn the_account_panel_switches_theme() {
    let mut rt = runtime(scenes::signed_in);
    press(&mut rt, "account-button");
    assert_eq!(rt.state.island, Island::Account);
    assert_eq!(text_of(&rt, "account-email"), "alex@example.com");
    press(&mut rt, "theme-Dark");
    assert_eq!(rt.state.theme, crate::settings::ThemeChoice::Dark);
    press(&mut rt, "close");
    assert_eq!(rt.state.island, Island::Nav);
}

#[test]
fn a_month_chip_opens_its_event_without_leaving_the_month() {
    let mut rt = runtime(|s| {
        scenes::signed_in(s);
        s.view = crate::data::page::View::Month;
    });
    press(&mut rt, "chip-climb");
    assert_eq!(rt.state.view, crate::data::page::View::Month);
    assert!(matches!(&rt.state.island, Island::Event(e) if e.id == "climb"));
}

fn open(id: &str) -> impl Fn(&mut State) {
    let id = id.to_string();
    move |s: &mut State| {
        scenes::signed_in(s);
        let e = s.events.iter().find(|e| e.id == id).cloned().unwrap();
        s.open_event(e);
    }
}

#[test]
fn delete_asks_to_confirm_then_deletes() {
    let mut rt = runtime(open("dentist"));
    press(&mut rt, "delete");
    assert!(rt.state.delete_armed.as_ref().is_some_and(|(id, _)| id == "dentist"));
    assert!(rt.elements().iter().any(|e| e.text.as_deref() == Some("Confirm?")));
    press(&mut rt, "delete");
    assert_eq!(rt.state.deleting.as_deref(), Some("dentist"));
    assert!(rt.elements().iter().any(|e| e.text.as_deref() == Some("Deleting…")));
}

#[test]
fn an_invitation_offers_removal_not_deletion() {
    let rt = runtime(open("review"));
    assert!(rt.elements().iter().any(|e| e.text.as_deref() == Some("Remove from my calendar")));
}

#[test]
fn a_repeating_event_picks_its_scope() {
    let mut rt = runtime(open("standup-2"));
    assert!(rt.find("delete-scopes").is_none());
    press(&mut rt, "delete");
    assert!(rt.find("delete-thisAndFollowing").is_some(), "the organiser gets all three scopes");
    press(&mut rt, "delete-allEvents");
    assert_eq!(rt.state.deleting.as_deref(), Some("standup-2"));
}

#[test]
fn a_deleted_event_leaves_the_grid_until_the_server_agrees() {
    let mut s = State::default();
    scenes::signed_in(&mut s);
    s.hidden_events.insert("dentist".into());
    let rt = {
        let mut rt = Runtime::new(s, view, crate::ui::views::WINDOW, Env { system_dark: false, scale: 2.0 });
        rt.frame(0.0);
        rt.frame(1.0 / 60.0);
        rt
    };
    assert!(rt.find("event-dentist").is_none());
    let mut s = rt.state;
    s.events.retain(|e| e.id != "dentist");
    s.settle_hidden();
    assert!(s.hidden_events.is_empty());
}
