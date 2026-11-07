//! A signed-in user's live data: one Convex websocket, authenticated with the Better Auth
//! session's JWT, holding the preferences, calendars and events subscriptions. Every new
//! result goes to the UI thread through `AppHandle::update`.

use std::collections::{BTreeMap, HashMap};
use std::pin::Pin;
use std::sync::Arc;

use anyhow::{Context, Result};
use convex::{AuthenticationToken, ConvexClient, FunctionResult, QuerySubscription, Value};
use futures::StreamExt;
use tokio::sync::watch;
use serde::de::DeserializeOwned;

use super::models::{CalendarEvent, CalendarListItem, StoredPreferences};
use crate::app::{Phase, State};
use crate::auth::{AuthError, BetterAuth};

const LIST_EVENTS: &str = "domains/calendar/queries:listEventsInRange";
const LIST_CALENDARS: &str = "domains/calendar/queries:listCalendars";
const MY_PREFERENCES: &str = "domains/preferences/queries:getMyPreferences";
pub const SYNC_NOW: &str = "domains/sync/engine:syncNow";
pub const RESPOND_TO_EVENT: &str = "domains/calendar/service:respondToEvent";
pub const DELETE_EVENT: &str = "domains/calendar/service:deleteEvent";

/// The signed-in session's Convex client, shared so actions (sync, RSVP) use its connection.
pub type ClientSlot = Arc<std::sync::Mutex<Option<ConvexClient>>>;

type Handle = rune::AppHandle<State>;

/// Runs until the task is aborted (sign-out) or the session turns out to be gone. `range`
/// carries the `[start, end)` the UI wants events for; `(0, 0)` until it knows.
pub async fn run(convex_url: String, auth: Arc<BetterAuth>, ui: Handle, range: watch::Receiver<(f64, f64)>, slot: ClientSlot) {
    if let Err(e) = live(&convex_url, auth, ui.clone(), range, slot).await {
        let message = format!("{e:#}");
        ui.update(move |s, _| s.error = Some(message));
    }
}

async fn live(convex_url: &str, auth: Arc<BetterAuth>, ui: Handle, mut range: watch::Receiver<(f64, f64)>, slot: ClientSlot) -> Result<()> {
    let mut client = ConvexClient::new(convex_url).await.context("Couldn't connect to Convex")?;
    client.set_auth_callback(Some(token_fetcher(auth, ui.clone()))).await;
    *slot.lock().unwrap() = Some(client.clone());

    // A first sync pulls anything Google changed while the app was closed; the subscriptions
    // pick up what it writes.
    let mut sync = client.clone();
    tokio::spawn(async move {
        if let Err(e) = sync.action(SYNC_NOW, BTreeMap::new()).await {
            eprintln!("qali: syncNow failed: {e:#}");
        }
    });

    let mut prefs_sub = client.subscribe(MY_PREFERENCES, BTreeMap::new()).await?;
    let mut calendars_sub = client.subscribe(LIST_CALENDARS, BTreeMap::new()).await?;

    // The UI cuts pages in the working zone, so it asks for a range once the preferences land.
    let mut events_sub: Option<QuerySubscription> = None;
    let current = *range.borrow_and_update();
    if current.1 > current.0 {
        events_sub = Some(subscribe_events(&mut client, current).await?);
    }

    loop {
        let next_events = async {
            match events_sub.as_mut() {
                Some(sub) => sub.next().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            Ok(()) = range.changed() => {
                let wanted = *range.borrow_and_update();
                // Replacing the subscription drops the old one; its events stay on screen until
                // the new range's first result replaces them.
                events_sub = Some(subscribe_events(&mut client, wanted).await?);
            }
            Some(result) = prefs_sub.next() => {
                let prefs = decode::<Option<StoredPreferences>>(result)?.unwrap_or_default();
                push_prefs(&ui, prefs);
            }
            Some(result) = calendars_sub.next() => {
                let calendars = decode::<Vec<CalendarListItem>>(result)?;
                let colors: HashMap<String, String> = calendars
                    .iter()
                    .filter_map(|c| c.background_color.clone().map(|hex| (c.id.clone(), hex)))
                    .collect();
                ui.update_if(move |s, _| {
                    let changed = s.calendar_colors != colors || s.calendars != calendars;
                    s.calendar_colors = colors;
                    s.calendars = calendars;
                    changed
                });
            }
            Some(result) = next_events => {
                let events = decode::<Vec<CalendarEvent>>(result)?;
                ui.update_if(move |s, tx| {
                    let changed = !s.loaded || s.events != events;
                    // The first list lands without animating rows in from nowhere.
                    if !s.loaded { tx.instant(); }
                    s.events = events;
                    s.loaded = true;
                    s.settle_rsvp();
                    s.settle_hidden();
                    changed
                });
            }
            else => return Ok(()),
        }
    }
}

async fn subscribe_events(client: &mut ConvexClient, (start, end): (f64, f64)) -> Result<QuerySubscription> {
    let args = BTreeMap::from([("startMs".to_string(), Value::Float64(start)), ("endMs".to_string(), Value::Float64(end))]);
    Ok(client.subscribe(LIST_EVENTS, args).await?)
}

fn push_prefs(ui: &Handle, prefs: StoredPreferences) {
    ui.update_if(move |s, _| {
        let changed = s.prefs != prefs;
        s.prefs = prefs;
        changed
    });
}

/// Mints a Convex JWT from the Better Auth session on connect and on every reconnect (the
/// client restarts the protocol after an `AuthError`, so an expired token is replaced there).
/// A session the server no longer knows signs the app out.
fn token_fetcher(auth: Arc<BetterAuth>, ui: Handle) -> convex::base_client::AuthTokenFetcher {
    Box::new(move |_force_refresh| {
        let auth = auth.clone();
        let ui = ui.clone();
        Box::pin(async move {
            match auth.convex_token().await {
                Ok(token) => Ok(AuthenticationToken::User(token)),
                Err(e) if matches!(e.downcast_ref::<AuthError>(), Some(AuthError::NotSignedIn)) => {
                    auth.jar.clear();
                    ui.update(|s, _| s.signed_out(Some("Your session expired. Sign in again.".into())));
                    Ok(AuthenticationToken::None)
                }
                Err(e) => Err(e),
            }
        }) as Pin<Box<dyn Future<Output = Result<AuthenticationToken>> + Send>>
    })
}

fn decode<T: DeserializeOwned>(result: FunctionResult) -> Result<T> {
    match result {
        FunctionResult::Value(value) => Ok(serde_json::from_value(value.export())?),
        FunctionResult::ErrorMessage(message) => anyhow::bail!(message),
        FunctionResult::ConvexError(e) => anyhow::bail!(e.message),
    }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

impl State {
    /// Back to the sign-in screen, dropping everything the session showed.
    pub fn signed_out(&mut self, error: Option<String>) {
        let images = self.images.take();
        let now_ms = self.now_ms;
        *self = State { phase: Phase::SignedOut, error, images, now_ms, ..State::default() };
    }
}

/// Runs an action on the session's client; a function error comes back as `Err`.
pub async fn call_action(mut client: ConvexClient, name: &str, args: BTreeMap<String, Value>) -> Result<()> {
    match client.action(name, args).await? {
        FunctionResult::Value(_) => Ok(()),
        FunctionResult::ErrorMessage(message) => anyhow::bail!(message),
        FunctionResult::ConvexError(e) => anyhow::bail!(e.message),
    }
}
