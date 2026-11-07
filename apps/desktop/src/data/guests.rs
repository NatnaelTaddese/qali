//! Guest suggestions, after `calendar/guest-picker.tsx`: synced contacts not already invited,
//! matching the search on name or email, best first; and a typed address to invite when it
//! looks like one.

use super::models::{Attendee, Contact};

pub const MAX_SUGGESTIONS: usize = 5;

/// Deliberately loose (Google validates for real): something@something.something, no spaces.
pub fn looks_like_email(s: &str) -> bool {
    let Some((user, domain)) = s.split_once('@') else { return false };
    !user.is_empty() && !s.chars().any(char::is_whitespace) && !domain.contains('@') && domain.split('.').count() >= 2 && domain.split('.').all(|p| !p.is_empty())
}

fn invited(guests: &[Attendee], email: &str) -> bool {
    guests.iter().any(|g| g.email.eq_ignore_ascii_case(email))
}

/// One row per address, skipping guests already on the event.
pub fn suggestions<'a>(people: &'a [Contact], query: &str, guests: &[Attendee]) -> Vec<&'a Contact> {
    let q = query.trim().to_lowercase();
    let mut out: Vec<&Contact> = Vec::new();
    for p in people {
        if invited(guests, &p.email) || out.iter().any(|o| o.email.eq_ignore_ascii_case(&p.email)) {
            continue;
        }
        let hay = format!("{} {}", p.display_name.as_deref().unwrap_or(""), p.email).to_lowercase();
        if !q.is_empty() && !hay.contains(&q) {
            continue;
        }
        out.push(p);
        if out.len() == MAX_SUGGESTIONS {
            break;
        }
    }
    out
}

/// The typed address, when it can be invited as it is: plausible, not a guest yet, and not
/// one of the suggestions already shown.
pub fn typed_invite(query: &str, guests: &[Attendee], shown: &[&Contact]) -> Option<String> {
    let typed = query.trim();
    (looks_like_email(typed) && !invited(guests, typed) && !shown.iter().any(|s| s.email.eq_ignore_ascii_case(typed))).then(|| typed.to_string())
}

/// The rows the picker offers, in order: suggestions, then the typed address.
pub fn choices(people: &[Contact], query: &str, guests: &[Attendee]) -> Vec<Attendee> {
    let shown = suggestions(people, query, guests);
    let typed = typed_invite(query, guests, &shown);
    shown
        .into_iter()
        .map(|c| Attendee { email: c.email.clone(), display_name: c.display_name.clone(), ..Default::default() })
        .chain(typed.map(|email| Attendee { email, ..Default::default() }))
        .collect()
}

/// Whether the guest list differs from the event's, by address and order (as the web
/// compares).
pub fn changed(guests: &[Attendee], original: &[Attendee]) -> bool {
    guests.len() != original.len() || guests.iter().zip(original).any(|(a, b)| a.email != b.email)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contact(email: &str, name: &str) -> Contact {
        Contact { email: email.into(), display_name: Some(name.into()), photo_url: None }
    }

    #[test]
    fn emails_are_checked_loosely() {
        assert!(looks_like_email("ana@example.com"));
        assert!(!looks_like_email("ana@example"));
        assert!(!looks_like_email("ana example@x.com"));
        assert!(!looks_like_email("@x.com"));
    }

    #[test]
    fn suggestions_skip_guests_and_match_names() {
        let people = [contact("ana@x.com", "Ana Lima"), contact("ben@x.com", "Ben Okafor"), contact("ANA@x.com", "Ana again")];
        let guests = [Attendee { email: "ben@x.com".into(), ..Default::default() }];
        let shown: Vec<_> = suggestions(&people, "", &guests).iter().map(|c| c.email.as_str()).collect();
        assert_eq!(shown, ["ana@x.com"], "one row per address, invited ones left out");
        assert!(suggestions(&people, "lima", &[]).len() == 1);
        assert_eq!(choices(&people, "zoe@x.com", &[]).last().map(|g| g.email.as_str()), Some("zoe@x.com"));
        assert_eq!(choices(&people, "ana@x.com", &[]).len(), 1, "no invite row for a shown contact");
        assert!(choices(&people, "ben@x.com", &guests).is_empty());
    }
}
