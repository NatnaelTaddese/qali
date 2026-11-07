//! The app's state, and the services (network, auth, Convex) that change it from other
//! threads. Rune's hooks are plain `fn`s, so the services live in one process-wide cell that
//! `main` fills; headless runs and tests never fill it, and every call is then a no-op.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::auth::cookie_jar::CookieJar;
use crate::auth::store::Store;
use crate::auth::{BetterAuth, SessionUser};
use crate::config::{Config, KEYCHAIN_SERVICE};
use crate::data::models::{CalendarEvent, StoredPreferences};
use crate::data::page::{self, View};
use crate::data::session;
use chrono::NaiveDate;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    /// Checking the stored session at launch.
    #[default]
    Restoring,
    SignedOut,
    /// Google sign-in is open in the browser; waiting for the `qali://` link.
    Waiting,
    SignedIn,
}

#[derive(Default)]
pub struct State {
    pub phase: Phase,
    pub error: Option<String>,
    pub user: Option<SessionUser>,
    pub prefs: StoredPreferences,
    pub calendar_colors: HashMap<String, String>,
    pub events: Vec<CalendarEvent>,
    /// The first events result has arrived.
    pub loaded: bool,
    /// `[start, end)` the events subscription covers, in epoch ms.
    pub window: (f64, f64),
    /// Seconds since launch while the loader shows (`AppSpec::poll`), for its colour loop.
    pub clock: f64,
    /// Decoded artwork, from `AppSpec::setup`. Tests run without it.
    pub images: Option<Images>,
    /// The time the week is drawn at: which week shows, today's column, the now line.
    pub now_ms: f64,
    /// Scenes and tests pin `now_ms`; the app follows the wall clock, a minute at a time.
    pub clock_pinned: bool,
    /// The all-day band shows every lane instead of the first two.
    pub all_day_expanded: bool,
    /// Scroll the hours so the now line is in view, once the week first has events.
    pub scroll_to_now: bool,
    /// The hours' scroll viewport height, as last laid out.
    pub hours_h: f32,
    /// Day, week or month.
    pub view: View,
    /// A date on the page showing; `None` follows today (and moves with it at midnight).
    pub focus: Option<NaiveDate>,
    /// Which way the last page change went (+1 later, -1 earlier): the new page slides in
    /// from that side while the old one fades.
    pub page_dir: i8,
    /// Every calendar, for names and access roles.
    pub calendars: Vec<crate::data::models::CalendarListItem>,
    /// What the island shows: the nav pill, an event, or the account panel.
    pub island: Island,
    /// A sync started from the island is running.
    pub syncing: bool,
    /// An RSVP sent and not yet reflected by the server: `(event id, status)`.
    pub rsvp_pending: Option<(String, String)>,
    /// Which copy button just copied, and until when it shows a tick.
    pub copied: Option<(&'static str, std::time::Instant)>,
    /// The detail panel's guest list and description are open.
    pub guests_expanded: bool,
    pub description_expanded: bool,
    /// Light, dark, or the Mac's setting.
    pub theme: crate::settings::ThemeChoice,
    /// The delete button asked "Confirm?" for this event, until then.
    pub delete_armed: Option<(String, std::time::Instant)>,
    /// A repeating event's delete scopes are showing.
    pub delete_scopes_open: bool,
    /// A delete is on its way for this event.
    pub deleting: Option<String>,
    /// Deleted here but still in the server's list until it catches up; drawn as gone.
    pub hidden_events: std::collections::HashSet<String>,
    /// An event being moved or resized.
    pub drag: Option<crate::data::drag::EventDrag>,
    /// New times sent to the server and not yet in its list: drawn in place of the old ones.
    pub time_overrides: HashMap<String, (f64, f64)>,
    /// Horizontal trackpad travel toward a page change, and when paging may resume.
    pub swipe: f32,
    pub swipe_resume: Option<std::time::Instant>,
}

pub struct Images {
    pub google: Option<rune::Image>,
    pub meet: Option<rune::Image>,
}

/// `AppSpec::setup`: decode the artwork once, on the cache's worker.
pub fn setup(s: &mut State, waker: rune::Waker) {
    let cache = rune::ImageCache::new(waker);
    // 16 pt at up to 3x; the mips cover smaller draws.
    let google = cache.svg(&include_bytes!("../assets/google.svg")[..], 16.0, 3.0);
    // Headless snapshots need it drawn on their first frame; the SVG is small.
    let meet = cache.svg(&include_bytes!("../assets/google-meet.svg")[..], 18.0, 3.0);
    let _ = google.wait();
    let _ = meet.wait();
    s.images = Some(Images { google: Some(google), meet: Some(meet) });
}

/// `AppSpec::poll`: drive the loader's colour loop while it shows; on the week, keep the clock
/// on the current minute and make the first scroll to the now line. Otherwise stay idle.
pub fn poll(s: &mut State, t: f64, tx: &mut rune::Tx) -> bool {
    match s.phase {
        Phase::Restoring => {
            s.clock = t;
            tx.wake_after(std::time::Duration::from_millis(16));
            true
        }
        Phase::SignedIn => {
            let mut changed = false;
            if !s.clock_pinned {
                let now = session::now_ms();
                let minute = |ms: f64| (ms / 60_000.0).floor();
                if minute(now) != minute(s.now_ms) {
                    s.now_ms = now;
                    changed = true;
                }
                let into_minute = now.rem_euclid(60_000.0);
                tx.wake_after(std::time::Duration::from_millis((60_000.0 - into_minute) as u64 + 5));
            }
            follow_page(s);
            if s.delete_armed.as_ref().is_some_and(|(_, until)| std::time::Instant::now() >= *until) {
                s.delete_armed = None;
                changed = true;
            }
            if s.copied.is_some_and(|(_, until)| std::time::Instant::now() >= until) {
                s.copied = None;
                changed = true;
            }
            if s.scroll_to_now && s.loaded {
                s.scroll_to_now = false;
                let viewport = if s.hours_h > 0.0 { s.hours_h } else { 520.0 };
                let y = crate::ui::calendar::home::now_scroll_y(s, viewport);
                tx.scroll_to_instant(crate::ui::calendar::SCROLL_KEY, 0.0, y);
            }
            changed
        }
        _ => false,
    }
}

pub struct Services {
    rt: tokio::runtime::Runtime,
    config: Config,
    auth: Arc<BetterAuth>,
    ui: rune::AppHandle<State>,
    data: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The signed-in session's Convex client, once connected.
    client: session::ClientSlot,
    /// The event range the signed-in session should load.
    range: Mutex<Option<tokio::sync::watch::Sender<(f64, f64)>>>,
}

static SERVICES: OnceLock<Services> = OnceLock::new();

pub fn install(config: Config, ui: rune::AppHandle<State>) {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("qali-net")
        .enable_all()
        .build()
        .expect("a tokio runtime");
    let jar = CookieJar::persistent(Store::keychain(KEYCHAIN_SERVICE, &config.keychain_account()));
    let auth = Arc::new(BetterAuth::new(&config.site_url(), jar));
    let services = Services { rt, config, auth, ui, data: Mutex::new(None), client: Default::default(), range: Mutex::new(None) };
    if SERVICES.set(services).is_err() {
        panic!("services installed twice");
    }
    // Headless renders (`--snap`, `--tree`, `--script`…) take their theme from `--theme`, not
    // from the user's saved choice.
    let headless = std::env::args().skip(1).any(|a| a.starts_with("--"));
    let theme = if headless { crate::settings::ThemeChoice::System } else { crate::settings::load().theme };
    if let Some(sv) = SERVICES.get() {
        sv.ui.update(move |s, _| s.theme = theme);
    }
}

fn services() -> Option<&'static Services> {
    SERVICES.get()
}

/// True in the running app; false in headless renders and tests, which must not touch disk.
pub fn is_running() -> bool {
    services().is_some()
}

/// At launch: a stored, still-valid session goes straight to the list.
pub fn restore() {
    let Some(sv) = services() else { return };
    let auth = sv.auth.clone();
    let ui = sv.ui.clone();
    sv.rt.spawn(async move {
        match auth.current_user().await {
            Ok(Some(user)) => signed_in(user),
            Ok(None) => ui.update(|s, tx| {
                tx.instant();
                s.signed_out(None)
            }),
            Err(e) => {
                let message = format!("{e:#}");
                ui.update(move |s, _| s.signed_out(Some(message)));
            }
        }
    });
}

/// "Continue with Google": asks the backend for the authorization URL and opens it.
pub fn sign_in() {
    let Some(sv) = services() else { return };
    let auth = sv.auth.clone();
    let ui = sv.ui.clone();
    sv.rt.spawn(async move {
        match auth.start_google().await {
            Ok(url) => ui.update(move |s, tx| {
                if s.phase != Phase::Waiting {
                    return; // cancelled meanwhile
                }
                if let Err(e) = tx.open_url(&url) {
                    s.signed_out(Some(format!("Couldn't open the browser: {e:?}")));
                }
            }),
            Err(e) => {
                let message = format!("{e:#}");
                ui.update(move |s, _| s.signed_out(Some(message)));
            }
        }
    });
}

/// A `qali://` link from macOS. Only a link while sign-in is waiting does anything.
pub fn open_url(s: &mut State, link: &str, _tx: &mut rune::Tx) {
    let Some(sv) = services() else { return };
    if s.phase != Phase::Waiting {
        return;
    }
    match sv.auth.complete(link) {
        Ok(true) => {
            sv.ui.open(); // bring the window back over the browser
            let auth = sv.auth.clone();
            let ui = sv.ui.clone();
            sv.rt.spawn(async move {
                match auth.current_user().await {
                    Ok(Some(user)) => signed_in(user),
                    Ok(None) => ui.update(|s, _| s.signed_out(Some("Sign-in didn't stick. Try again.".into()))),
                    Err(e) => {
                        let message = format!("{e:#}");
                        ui.update(move |s, _| s.signed_out(Some(message)));
                    }
                }
            });
        }
        Ok(false) => {}
        Err(e) => s.signed_out(Some(format!("{e:#}"))),
    }
}

fn signed_in(user: SessionUser) {
    let Some(sv) = services() else { return };
    sv.ui.update(move |s, _| {
        s.phase = Phase::SignedIn;
        s.error = None;
        s.user = Some(user);
        s.now_ms = session::now_ms();
        s.scroll_to_now = true;
        s.window = (0.0, 0.0);
    });
    let (range_tx, range_rx) = tokio::sync::watch::channel((0.0, 0.0));
    *sv.range.lock().unwrap() = Some(range_tx);
    let task = sv.rt.spawn(session::run(sv.config.convex_url(), sv.auth.clone(), sv.ui.clone(), range_rx, sv.client.clone()));
    if let Some(old) = sv.data.lock().unwrap().replace(task) {
        old.abort();
    }
}

pub fn sign_out() {
    let Some(sv) = services() else { return };
    sv.client.lock().unwrap().take();
    if let Some(task) = sv.data.lock().unwrap().take() {
        task.abort(); // dropping the client closes the websocket
    }
    let auth = sv.auth.clone();
    sv.rt.spawn(async move { auth.sign_out().await });
}

/// Ask the session for the events a page needs when what's loaded doesn't cover it. Runs from
/// `poll`, so a page change, a preference change and midnight all land here.
pub fn follow_page(s: &mut State) {
    let zone = crate::data::days::working_zone(s.prefs.time_zone.as_deref());
    let wso = s.prefs.week_starts_on();
    let start = page::page_start(s.view, s.page_focus(), wso);
    let days = page::page_days(s.view, start, wso);
    let shown = crate::data::week::range_ms(&days, zone);
    if page::covers(s.window, shown) {
        return;
    }
    s.window = page::query_range(s.view, start, zone, wso);
    if let Some(sv) = services()
        && let Some(tx) = sv.range.lock().unwrap().as_ref()
    {
        let _ = tx.send(s.window);
    }
}

impl State {
    /// Today in the working zone.
    pub fn today(&self) -> NaiveDate {
        crate::data::days::today(self.now_ms, crate::data::days::working_zone(self.prefs.time_zone.as_deref()))
    }

    /// A date on the page showing.
    pub fn page_focus(&self) -> NaiveDate {
        self.focus.unwrap_or_else(|| self.today())
    }

    /// The first day of the page showing.
    pub fn page_start(&self) -> NaiveDate {
        page::page_start(self.view, self.page_focus(), self.prefs.week_starts_on())
    }

    /// Move `n` pages (‹ › and the arrow keys).
    pub fn step(&mut self, n: i32) {
        let target = page::add_pages(self.view, self.page_start(), n);
        self.go(Some(target), n.signum() as i8);
    }

    /// Back to the page with today on it.
    pub fn go_today(&mut self) {
        let wso = self.prefs.week_starts_on();
        let today_page = page::page_start(self.view, self.today(), wso);
        let dir = (today_page - self.page_start()).num_days().signum() as i8;
        self.go(None, dir);
    }

    pub fn set_view(&mut self, view: View) {
        self.view = view;
        self.swipe = 0.0;
    }

    /// Month cells open their day.
    pub fn open_day(&mut self, day: NaiveDate) {
        self.view = View::Day;
        self.focus = if day == self.today() { None } else { Some(day) };
    }

    /// Change page; the new one slides in from the side `dir` points to.
    fn go(&mut self, focus: Option<NaiveDate>, dir: i8) {
        if dir != 0 {
            self.page_dir = dir;
        }
        self.focus = focus;
    }
}

/// `AppSpec::on_key`, on the week only, with no modifier but Shift: T for today, D / W / M for
/// the views, ← → (or J / K) to step pages. ⌘1–3 also switch views, as in Calendar.
pub fn on_key(s: &mut State, e: &rune::KeyEvent, _tx: &mut rune::Tx) -> bool {
    use rune::Key;
    if e.key == Key::Escape && s.island != Island::Nav {
        s.close_island();
        return true;
    }
    if s.phase != Phase::SignedIn || e.mods.alt || e.mods.ctrl {
        return false;
    }
    match (&e.key, e.mods.cmd) {
        (Key::Command(c), true) => match c {
            '1' => s.set_view(View::Day),
            '2' => s.set_view(View::Week),
            '3' => s.set_view(View::Month),
            _ => return false,
        },
        (_, true) => return false,
        (Key::Left, false) => s.step(-1),
        (Key::Right, false) => s.step(1),
        (Key::Text(t), false) => match t.to_lowercase().as_str() {
            "t" => s.go_today(),
            "d" => s.set_view(View::Day),
            "w" => s.set_view(View::Week),
            "m" => s.set_view(View::Month),
            "j" => s.step(1),
            "k" => s.step(-1),
            _ => return false,
        },
        _ => return false,
    }
    true
}

/// The island's views (`DockView` on the web), so far the ones that read rather than edit.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Island {
    #[default]
    Nav,
    /// The event as it was when opened; the panel prefers the live row with the same id.
    Event(CalendarEvent),
    Account,
}

impl State {
    pub fn open_event(&mut self, event: CalendarEvent) {
        if !matches!(&self.island, Island::Event(e) if e.id == event.id) {
            self.guests_expanded = false;
            self.description_expanded = false;
            self.delete_armed = None;
            self.delete_scopes_open = false;
        }
        self.island = Island::Event(event);
    }

    pub fn close_island(&mut self) {
        self.island = Island::Nav;
    }

    /// The open event, live from the current list when it's still there.
    pub fn island_event(&self) -> Option<&CalendarEvent> {
        match &self.island {
            Island::Event(snapshot) => Some(self.events.iter().find(|e| e.id == snapshot.id).unwrap_or(snapshot)),
            _ => None,
        }
    }

    /// The events to draw: the server's list without the ones deleted here, and with times
    /// changed here in place of the server's until it catches up.
    pub fn shown_events(&self) -> Vec<CalendarEvent> {
        self.events
            .iter()
            .filter(|e| !self.hidden_events.contains(&e.id))
            .map(|e| match self.time_overrides.get(&e.id) {
                Some(&(start_ms, end_ms)) => CalendarEvent { start_ms, end_ms, ..e.clone() },
                None => e.clone(),
            })
            .collect()
    }

    /// Forget hidden ids and time overrides once the server's list agrees.
    pub fn settle_hidden(&mut self) {
        let events = &self.events;
        self.hidden_events.retain(|id| events.iter().any(|e| &e.id == id));
        self.time_overrides.retain(|id, (start, end)| events.iter().any(|e| &e.id == id && (e.start_ms != *start || e.end_ms != *end)));
    }

    /// Drop an optimistic RSVP once the server's copy agrees.
    pub fn settle_rsvp(&mut self) {
        let Some((id, status)) = &self.rsvp_pending else { return };
        let settled = self.events.iter().find(|e| &e.id == id).and_then(|e| e.attendees.as_ref()).and_then(|a| a.iter().find(|g| g.is_self == Some(true))).and_then(|g| g.response_status.as_deref()) == Some(status.as_str());
        if settled {
            self.rsvp_pending = None;
        }
    }

    /// Light or dark, from the user's choice or the Mac's.
    pub fn dark(&self, system_dark: bool) -> bool {
        match self.theme {
            crate::settings::ThemeChoice::System => system_dark,
            crate::settings::ThemeChoice::Light => false,
            crate::settings::ThemeChoice::Dark => true,
        }
    }
}

fn spawn_action(name: &'static str, args: std::collections::BTreeMap<String, convex::Value>, done: impl FnOnce(&mut State, Option<String>) + Send + 'static) {
    let Some(sv) = services() else { return };
    let Some(client) = sv.client.lock().unwrap().clone() else {
        sv.ui.update(move |s, _| done(s, Some("Not connected yet. Try again in a moment.".into())));
        return;
    };
    let ui = sv.ui.clone();
    sv.rt.spawn(async move {
        let error = session::call_action(client, name, args).await.err().map(|e| format!("{e:#}"));
        ui.update(move |s, _| done(s, error));
    });
}

/// The island's sync button: pull from Google now (`syncNow`). A rate limit says so quietly.
pub fn sync_now(s: &mut State) {
    if s.syncing {
        return;
    }
    s.syncing = true;
    spawn_action(session::SYNC_NOW, Default::default(), |s, error| {
        s.syncing = false;
        if let Some(error) = error.filter(|e| !e.contains("SYNC_RATE_LIMIT")) {
            s.error = Some(format!("Couldn't sync: {error}"));
        }
    });
}

/// Answer an invitation (`respondToEvent`), showing the answer at once.
pub fn respond(s: &mut State, event_id: String, status: &'static str) {
    s.rsvp_pending = Some((event_id.clone(), status.to_string()));
    let args = std::collections::BTreeMap::from([
        ("eventId".to_string(), convex::Value::String(event_id)),
        ("responseStatus".to_string(), convex::Value::String(status.to_string())),
    ]);
    spawn_action(session::RESPOND_TO_EVENT, args, |s, error| {
        if let Some(error) = error {
            s.rsvp_pending = None;
            s.error = Some(format!("Couldn't send your reply: {error}"));
        }
    });
}

/// Delete an event, or remove your copy of one you were invited to (`deleteEvent`). `scope` is
/// "thisEvent", "thisAndFollowing" or "allEvents"; the operation id makes a retry safe. On
/// success the event disappears at once and its panel closes.
pub fn delete_event(s: &mut State, event_id: String, scope: &'static str) {
    if s.deleting.is_some() {
        return;
    }
    s.deleting = Some(event_id.clone());
    let args = std::collections::BTreeMap::from([
        ("eventId".to_string(), convex::Value::String(event_id.clone())),
        ("scope".to_string(), convex::Value::String(scope.to_string())),
        ("operationId".to_string(), convex::Value::String(uuid::Uuid::new_v4().to_string())),
    ]);
    spawn_action(session::DELETE_EVENT, args, move |s, error| {
        s.deleting = None;
        s.delete_armed = None;
        s.delete_scopes_open = false;
        match error {
            None => {
                s.hidden_events.insert(event_id.clone());
                if matches!(&s.island, Island::Event(e) if e.id == event_id) {
                    s.close_island();
                }
            }
            Some(error) => s.error = Some(format!("Couldn't remove the event: {error}")),
        }
    });
}

/// Reschedule an event (`updateEventTime`), drawing it at its new time at once and putting it
/// back if the server refuses.
pub fn update_event_time(s: &mut State, event_id: String, start_ms: f64, end_ms: f64) {
    s.time_overrides.insert(event_id.clone(), (start_ms, end_ms));
    let zone = crate::data::days::working_zone(s.prefs.time_zone.as_deref());
    let args = std::collections::BTreeMap::from([
        ("eventId".to_string(), convex::Value::String(event_id.clone())),
        ("startMs".to_string(), convex::Value::Float64(start_ms)),
        ("endMs".to_string(), convex::Value::Float64(end_ms)),
        ("timeZone".to_string(), convex::Value::String(zone.name().to_string())),
    ]);
    spawn_action(session::UPDATE_EVENT_TIME, args, move |s, error| {
        if let Some(error) = error {
            s.time_overrides.remove(&event_id);
            s.error = Some(format!("Couldn't reschedule the event: {error}"));
        }
    });
}
