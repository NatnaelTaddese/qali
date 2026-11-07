//! What the user may do with an event, ported from `packages/domain/src/permissions.ts`
//! (`eventCapabilities`). The rules the detail panel and the form read.

use super::models::{CalendarEvent, CalendarListItem};

const WRITABLE_ACCESS_ROLES: [&str; 2] = ["owner", "writer"];
/// Event types Google generates and maintains itself: readable, never editable.
const GOOGLE_MANAGED_EVENT_TYPES: [&str; 3] = ["birthday", "workingLocation", "fromGmail"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub can_edit: bool,
    pub can_invite_others: bool,
    pub can_see_guests: bool,
    /// Hard delete: cancels the event for every guest.
    pub can_delete: bool,
    /// Remove your own copy, leaving the organiser's untouched.
    pub can_remove_self: bool,
    pub can_respond: bool,
    /// A repeating row is one expanded instance with no rule of its own to edit.
    pub can_change_recurrence: bool,
    pub is_organizer: bool,
    /// Why editing is off, phrased for the user; `None` when it isn't.
    pub read_only_reason: Option<&'static str>,
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
    // First matching rule wins: the reason names the most fundamental obstacle.
    let read_only_reason = if google_managed {
        Some("Google manages this event")
    } else if !writable {
        Some("You have read-only access to this calendar")
    } else if event.locked == Some(true) {
        Some("The organiser locked this event")
    } else if !is_organizer && event.guests_can_modify != Some(true) {
        Some("Only the organiser can edit this event")
    } else {
        None
    };
    let can_edit = read_only_reason.is_none();
    Capabilities {
        can_edit,
        // `guestsCanInviteOthers` defaults to true.
        can_invite_others: can_edit && (is_organizer || event.guests_can_invite_others != Some(false)),
        can_change_recurrence: can_edit && event.provider_series_id.is_none(),
        can_delete: writable && !google_managed && is_organizer,
        can_remove_self: writable && !google_managed && !is_organizer && self_attendee.is_some(),
        read_only_reason,
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
    fn edit_and_delete_follow_the_first_obstacle() {
        let mine = CalendarEvent { organizer: Some(Person { is_self: Some(true), ..Default::default() }), ..Default::default() };
        let caps = capabilities(&mine, Some(&calendar("owner")));
        assert!(caps.can_edit && caps.can_delete && !caps.can_remove_self);
        assert_eq!(capabilities(&mine, Some(&calendar("reader"))).read_only_reason, Some("You have read-only access to this calendar"));
        let invited = CalendarEvent {
            attendees: Some(vec![me("accepted")]),
            organizer: Some(Person { is_self: Some(false), ..Default::default() }),
            ..Default::default()
        };
        let caps = capabilities(&invited, Some(&calendar("writer")));
        assert_eq!(caps.read_only_reason, Some("Only the organiser can edit this event"));
        assert!(!caps.can_delete && caps.can_remove_self);
        let locked = CalendarEvent { locked: Some(true), ..mine.clone() };
        assert_eq!(capabilities(&locked, Some(&calendar("owner"))).read_only_reason, Some("The organiser locked this event"));
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
