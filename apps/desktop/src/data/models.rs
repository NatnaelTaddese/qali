//! Serde mirrors of the Convex query results the app reads. Field names follow the backend
//! validators (`packages/backend/convex/domains/calendar/validators.ts` and `queries.ts`).
//! Unknown fields are ignored; optional validator fields are `Option`s.

use serde::Deserialize;

/// A guest on an event (`attendeeValidator`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attendee {
    pub email: String,
    pub display_name: Option<String>,
    /// "needsAction" | "accepted" | "tentative" | "declined".
    pub response_status: Option<String>,
    pub organizer: Option<bool>,
    #[serde(rename = "self")]
    pub is_self: Option<bool>,
}

impl Attendee {
    pub fn name(&self) -> &str {
        self.display_name.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(&self.email)
    }
}

/// An organizer or creator (`personValidator`).
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub email: Option<String>,
    pub display_name: Option<String>,
    #[serde(rename = "self")]
    pub is_self: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Reminder {
    /// "popup" | "email".
    pub method: String,
    pub minutes: f64,
}

/// One row of `listEventsInRange`: a synced `events` row, or a public-calendar `sharedEvents`
/// row mapped into the same shape.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    #[serde(rename = "_id")]
    pub id: String,
    pub start_ms: f64,
    pub end_ms: f64,
    pub all_day: bool,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub status: String,
    pub html_link: Option<String>,
    /// Google palette key "1"…"11"; `None` inherits the calendar's colour.
    pub color: Option<String>,
    /// "default" | "public" | "private" | "confidential".
    pub visibility: Option<String>,
    /// Absent means busy; only an explicit `false` means free.
    pub busy: Option<bool>,
    pub attendees: Option<Vec<Attendee>>,
    pub organizer: Option<Person>,
    pub guests_can_modify: Option<bool>,
    pub guests_can_invite_others: Option<bool>,
    pub guests_can_see_other_guests: Option<bool>,
    pub locked: Option<bool>,
    pub event_type: Option<String>,
    pub provider_series_id: Option<String>,
    pub conference_url: Option<String>,
    pub conference_name: Option<String>,
    pub conference_type: Option<String>,
    /// `None` = the calendar's default reminders apply; `Some([])` = none.
    pub reminders: Option<Vec<Reminder>>,
    pub local_calendar_id: Option<String>,
    /// Present on the user's own synced rows (not on public-calendar rows).
    pub user_id: Option<String>,
}

impl CalendarEvent {
    pub fn title(&self) -> &str {
        self.summary.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("(No title)")
    }
}

/// One row of the `listCalendars` DTO.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarListItem {
    #[serde(rename = "_id")]
    pub id: String,
    pub provider_calendar_id: Option<String>,
    pub summary: Option<String>,
    pub summary_override: Option<String>,
    pub background_color: Option<String>,
    pub access_role: Option<String>,
    pub primary: Option<bool>,
    pub selected: Option<bool>,
}

impl CalendarListItem {
    /// `calendarDisplayName`.
    pub fn display_name(&self) -> &str {
        self.summary_override.as_deref().or(self.summary.as_deref()).or(self.provider_calendar_id.as_deref()).unwrap_or("")
    }
}

/// The `getMyPreferences` DTO. Absent fields mean "automatic".
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPreferences {
    pub time_zone: Option<String>,
    /// date-fns numbering: 0 Sunday, 1 Monday, 6 Saturday.
    pub week_starts_on: Option<f64>,
    /// "12h" | "24h".
    pub time_format: Option<String>,
}

impl StoredPreferences {
    /// Monday unless the user picked another day (the web's `WEEK_STARTS_ON`).
    pub fn week_starts_on(&self) -> u32 {
        match self.week_starts_on.map(|d| d as u32) {
            Some(d @ (0 | 1 | 6)) => d,
            _ => 1,
        }
    }

    pub fn use_24h(&self) -> bool {
        self.time_format.as_deref() == Some("24h")
    }
}
