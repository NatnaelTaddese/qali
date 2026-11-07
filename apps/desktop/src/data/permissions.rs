//! What the user may do with an event, ported from `packages/domain/src/permissions.ts`
//! (`eventCapabilities`). Only the rules the detail panel reads so far.

use super::models::{CalendarEvent, CalendarListItem};

const WRITABLE_ACCESS_ROLES: [&str; 2] = ["owner", "writer"];
/// Event types Google generates and maintains itself: readable, never editable.
const GOOGLE_MANAGED_EVENT_TYPES: [&str; 3] = ["birthday", "workingLocation", "fromGmail"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub can_see_guests: bool,
    pub can_respond: bool,
    pub is_organizer: bool,
    /// Your own RSVP: "needsAction" | "declined" | "tentative" | "accepted".
    pub self_response: Option<String>,
}

pub fn capabilities(event: &CalendarEvent, calendar: Option<&CalendarListItem>) -> Capabilities {
    let self_attendee = event.attendees.as_ref().and_then(|a| a.iter().find(|g| g.is_self == Some(true)));
    let writable = calendar.and_then(|c| c.access_role.as_deref()).is_some_and(|r| WRITABLE_ACCESS_ROLES.contains(&r));
    let google_managed = event.event_type.as_deref().is_some_and(|t| GOOGLE_MANAGED_EVENT_TYPES.contains(&t));
    // Rows synced before these fields existed fall back to the calendar's access role.
    let unknown_provenance = event.organizer.is_none() && event.attendees.is_none();
    let is_organizer = event.organizer.as_ref().and_then(|o| o.is_self) == Some(true) || (unknown_provenance && writable);
    Capabilities {
        can_see_guests: !google_managed && (is_organizer || event.guests_can_see_other_guests.unwrap_or(true)),
        // Answering an invitation isn't editing it, so it works on locked events too.
        can_respond: writable && self_attendee.is_some(),
        is_organizer,
        self_response: self_attendee.and_then(|a| a.response_status.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::models::{Attendee, Person};

    fn calendar(role: &str) -> CalendarListItem {
        CalendarListItem { id: "c".into(), access_role: Some(role.into()), ..Default::default() }
    }

    fn me(status: &str) -> Attendee {
        Attendee { email: "me@x".into(), response_status: Some(status.into()), is_self: Some(true), ..Default::default() }
    }

    #[test]
    fn a_guest_on_a_writable_calendar_can_respond() {
        let event = CalendarEvent {
            attendees: Some(vec![me("needsAction")]),
            organizer: Some(Person { email: Some("boss@x".into()), ..Default::default() }),
            ..Default::default()
        };
        let caps = capabilities(&event, Some(&calendar("writer")));
        assert!(caps.can_respond && !caps.is_organizer);
        assert_eq!(caps.self_response.as_deref(), Some("needsAction"));
        assert!(!capabilities(&event, Some(&calendar("reader"))).can_respond);
    }

    #[test]
    fn hidden_guest_lists_stay_hidden_from_guests_but_not_the_organizer() {
        let mut event = CalendarEvent { attendees: Some(vec![me("accepted")]), guests_can_see_other_guests: Some(false), ..Default::default() };
        event.organizer = Some(Person { is_self: Some(false), ..Default::default() });
        assert!(!capabilities(&event, Some(&calendar("owner"))).can_see_guests);
        event.organizer = Some(Person { is_self: Some(true), ..Default::default() });
        assert!(capabilities(&event, Some(&calendar("owner"))).can_see_guests);
        event.event_type = Some("birthday".into());
        assert!(!capabilities(&event, Some(&calendar("owner"))).can_see_guests);
    }
}
