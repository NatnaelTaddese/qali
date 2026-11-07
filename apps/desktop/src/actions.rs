//! What the app asks the backend to do: sync, RSVP, delete, move, and save the form. Each
//! runs on the Convex client off the UI thread and reports back through `State`.

use crate::app::{Island, State, services};
use crate::data::models::Attendee;
use crate::data::session;

pub(crate) fn spawn_action(name: &'static str, args: std::collections::BTreeMap<String, convex::Value>, done: impl FnOnce(&mut State, Option<String>) + Send + 'static) {
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

fn s_val(v: &str) -> convex::Value {
    convex::Value::String(v.to_string())
}

fn reminders_value(minutes: &[f64]) -> convex::Value {
    convex::Value::Array(
        minutes
            .iter()
            .map(|m| convex::Value::Object(std::collections::BTreeMap::from([("method".to_string(), s_val("popup")), ("minutes".to_string(), convex::Value::Float64(*m))])))
            .collect(),
    )
}

/// How far an edit of a repeating event reaches (`SAVE_SCOPES`).
pub const SAVE_SCOPES: [(&str, &str); 3] = [("thisEvent", "This event"), ("thisAndFollowing", "This and following events"), ("allEvents", "All events")];

fn attendees_value(guests: &[Attendee], original: &[Attendee]) -> convex::Value {
    use convex::Value;
    Value::Array(
        guests
            .iter()
            .map(|g| {
                let mut o = std::collections::BTreeMap::from([("email".to_string(), s_val(&g.email))]);
                if let Some(name) = &g.display_name {
                    o.insert("displayName".into(), s_val(name));
                }
                // Patching replaces the list, so carry each guest's answer across, or saving
                // any change would reset everyone to "needs action".
                if let Some(old) = original.iter().find(|a| a.email.eq_ignore_ascii_case(&g.email)) {
                    if let Some(status) = &old.response_status {
                        o.insert("responseStatus".into(), s_val(status));
                    }
                    if let Some(optional) = old.optional {
                        o.insert("optional".into(), Value::Boolean(optional));
                    }
                }
                Value::Object(o)
            })
            .collect(),
    )
}

fn recurrence_value(rule: &crate::data::rrule::Recurrence, zone: chrono_tz::Tz) -> convex::Value {
    convex::Value::Array(rule.to_rrule(zone).iter().map(|l| s_val(l)).collect())
}

/// The action and arguments that save the form: everything set for a new event, only what
/// changed for an edit, which reaches `scope` of a repeating event.
pub fn save_args(s: &State, scope: &'static str) -> Option<(&'static str, std::collections::BTreeMap<String, convex::Value>)> {
    let draft = s.draft.as_ref()?;
    let zone = crate::data::days::working_zone(s.prefs.time_zone.as_deref());
    let title = s.draft_title.text.trim().to_string();
    let location = s.draft_location.text.trim().to_string();
    let description = s.draft_description.text.trim().to_string();
    let mut args = std::collections::BTreeMap::new();
    let mut put = |k: &str, v: convex::Value| {
        args.insert(k.to_string(), v);
    };
    put("timeZone", s_val(zone.name()));
    put("operationId", s_val(&draft.operation_id));

    let name = match &draft.editing {
        None => {
            put("summary", s_val(if title.is_empty() { "New event" } else { &title }));
            put("startMs", convex::Value::Float64(draft.start_ms));
            put("endMs", convex::Value::Float64(draft.end_ms));
            if draft.all_day {
                put("allDay", convex::Value::Boolean(true));
            }
            if let Some(id) = &draft.calendar_id {
                put("calendarId", s_val(id));
            }
            if !description.is_empty() {
                put("description", s_val(&description));
            }
            if draft.meet {
                put("addConference", convex::Value::Boolean(true));
            } else if !location.is_empty() {
                put("location", s_val(&location));
            }
            if let Some(color) = &draft.color {
                put("color", s_val(color));
            }
            if draft.private {
                put("visibility", s_val("private"));
            }
            if !draft.busy {
                put("busy", convex::Value::Boolean(false));
            }
            if let Some(minutes) = &draft.reminders {
                put("reminders", reminders_value(minutes));
            }
            if let Some(rule) = &draft.recurrence {
                put("recurrence", recurrence_value(rule, zone));
            }
            if !draft.guests.is_empty() {
                put("attendees", attendees_value(&draft.guests, &[]));
            }
            session::CREATE_EVENT
        }
        Some(original) => {
            put("eventId", s_val(&original.id));
            if original.provider_series_id.is_some() {
                put("scope", s_val(scope));
            }
            if Some(title.as_str()) != original.summary.as_deref() && !title.is_empty() {
                put("summary", s_val(&title));
            }
            let old_description = original.description.as_deref().map(crate::data::detail::preview_text).unwrap_or_default();
            if description != old_description {
                put("description", if description.is_empty() { convex::Value::Null } else { s_val(&description) });
            }
            let old_location = original.location.clone().unwrap_or_default();
            if !draft.meet && location != old_location {
                put("location", if location.is_empty() { convex::Value::Null } else { s_val(&location) });
            }
            match (draft.meet, original.conference_url.is_some()) {
                (true, false) => put("conference", s_val("meet")),
                (false, true) => put("conference", convex::Value::Null),
                _ => {}
            }
            if draft.color != original.color {
                put("color", draft.color.as_deref().map_or(convex::Value::Null, s_val));
            }
            if draft.private != (original.visibility.as_deref() == Some("private")) {
                put("visibility", if draft.private { s_val("private") } else { convex::Value::Null });
            }
            if draft.busy != (original.busy != Some(false)) {
                put("busy", convex::Value::Boolean(draft.busy));
            }
            if (draft.start_ms, draft.end_ms, draft.all_day) != (original.start_ms, original.end_ms, original.all_day) {
                put("startMs", convex::Value::Float64(draft.start_ms));
                put("endMs", convex::Value::Float64(draft.end_ms));
                put("allDay", convex::Value::Boolean(draft.all_day));
            }
            let old_reminders = original.reminders.as_ref().map(|r| r.iter().filter(|r| r.method == "popup").map(|r| r.minutes).collect::<Vec<_>>());
            if draft.reminders != old_reminders {
                put("reminders", draft.reminders.as_deref().map_or(convex::Value::Null, reminders_value));
            }
            // An event being edited never carries a rule, so any rule is a change.
            if let Some(rule) = &draft.recurrence {
                put("recurrence", recurrence_value(rule, zone));
            }
            let old_guests = original.attendees.clone().unwrap_or_default();
            if crate::data::guests::changed(&draft.guests, &old_guests) {
                put("attendees", attendees_value(&draft.guests, &old_guests));
            }
            session::UPDATE_EVENT
        }
    };
    Some((name, args))
}

/// Save the form: `createEvent` for a new event (an empty title becomes "New event"), or
/// `updateEvent` with only what changed for an edit. An edit of a repeating event asks how
/// far it reaches first (`save_event` with the chosen scope).
pub fn create_event(s: &mut State) {
    let Some(draft) = s.draft.as_mut() else { return };
    if draft.editing.as_ref().is_some_and(|e| e.provider_series_id.is_some()) {
        draft.save_scopes_open = !draft.save_scopes_open;
        draft.menu = None;
        return;
    }
    save_event(s, "thisEvent");
}

/// Created events arrive through the subscription; an edit returns to the event's panel.
pub fn save_event(s: &mut State, scope: &'static str) {
    let Some(draft) = s.draft.as_mut() else { return };
    if draft.submitting || draft.end_ms <= draft.start_ms {
        return;
    }
    draft.submitting = true;
    draft.save_scopes_open = false;
    let Some((name, args)) = save_args(s, scope) else { return };
    let done_editing = s.draft.as_ref().and_then(|d| d.editing.clone());
    spawn_action(name, args, move |s, error| match (error, done_editing) {
        (None, None) => s.close_island(),
        (None, Some(original)) => {
            s.draft = None;
            s.open_event(original);
        }
        (Some(error), _) => {
            if let Some(d) = s.draft.as_mut() {
                d.submitting = false;
            }
            s.error = Some(format!("Couldn't save the event: {error}"));
        }
    });
}

/// Create (the island's + and N): a new event in the next free slot on the page's day, as
/// the web's `openCreate` does.
pub fn new_event_now(s: &mut State) {
    let zone = crate::data::days::working_zone(s.prefs.time_zone.as_deref());
    let day = s.page_focus();
    let day_start = crate::data::days::start_of_day_ms(day, zone);
    let day_end = crate::data::days::start_of_day_ms(day.succ_opt().unwrap_or(day), zone);
    let (start, end) = crate::data::draft::next_free_slot(day_start, day_end, &s.shown_events(), s.now_ms);
    s.open_create(start, end);
}
