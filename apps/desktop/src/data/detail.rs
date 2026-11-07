//! The words the event detail panel shows, ported from the web: `timeText` and
//! `formatDistanceToNowStrict` (event-detail.tsx), `labelFor` (reminders.ts), the RSVP buckets
//! (guest-picker.tsx), avatar colours (avatar.tsx) and `htmlToPreviewText`.

use chrono::{DateTime, Datelike, TimeZone};
use chrono_tz::Tz;

use super::models::{Attendee, CalendarEvent};
use super::week::MS_PER_DAY;

const MONTHS_SHORT: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

fn at(ms: f64, zone: Tz) -> DateTime<Tz> {
    zone.timestamp_millis_opt(ms as i64).earliest().unwrap_or_else(|| zone.timestamp_millis_opt(0).unwrap())
}

/// "Wed 11 Nov".
pub fn day_label(d: chrono::NaiveDate) -> String {
    format!("{} {} {}", super::page::weekday_short(d), d.day(), MONTHS_SHORT[d.month0() as usize])
}

/// `timeText`: "Wed 11 Nov, 3:00 PM – 4:00 PM", the end with its own day when it's another day,
/// and all-day events as one day or a range of days (their bounds are UTC midnights).
pub fn time_text(e: &CalendarEvent, zone: Tz, use_24h: bool) -> String {
    let clock = |ms| crate::ui::calendar::clock(ms, zone, use_24h, true);
    if e.all_day {
        let utc = |ms: f64| DateTime::from_timestamp_millis(ms as i64).unwrap_or_default().date_naive();
        let (first, last) = (utc(e.start_ms), utc(e.end_ms - MS_PER_DAY).max(utc(e.start_ms)));
        return if first == last { day_label(first) } else { format!("{} – {}", day_label(first), day_label(last)) };
    }
    let (start, end) = (at(e.start_ms, zone), at(e.end_ms, zone));
    let end_text = if start.date_naive() == end.date_naive() { clock(e.end_ms) } else { format!("{}, {}", day_label(end.date_naive()), clock(e.end_ms)) };
    format!("{}, {} – {}", day_label(start.date_naive()), clock(e.start_ms), end_text)
}

/// `formatDistanceToNowStrict(…, { addSuffix: true })`: "in 25 minutes", "2 days ago".
pub fn relative(target_ms: f64, now_ms: f64) -> String {
    let diff = (target_ms - now_ms) / 1000.0;
    let secs = diff.abs();
    let (n, unit) = if secs < 60.0 {
        (secs, "second")
    } else if secs < 3600.0 {
        (secs / 60.0, "minute")
    } else if secs < 86_400.0 {
        (secs / 3600.0, "hour")
    } else if secs < 30.0 * 86_400.0 {
        (secs / 86_400.0, "day")
    } else if secs < 365.0 * 86_400.0 {
        (secs / (30.4375 * 86_400.0), "month")
    } else {
        (secs / (365.25 * 86_400.0), "year")
    };
    let n = n.round().max(if secs < 60.0 { 0.0 } else { 1.0 }) as i64;
    let amount = format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    if diff >= 0.0 { format!("in {amount}") } else { format!("{amount} ago") }
}

/// `labelFor`: "10 min before", "1 hour before", "The day before at 9:00 AM".
pub fn reminder_label(minutes: f64, all_day: bool, use_24h: bool) -> String {
    let minutes = minutes.round() as i64;
    let plural = |n: i64, unit: &str| format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    if all_day {
        let days = (minutes as f64 / (24.0 * 60.0)).ceil() as i64;
        let time_of_day = days * 24 * 60 - minutes;
        let (h, m) = (time_of_day / 60, time_of_day % 60);
        let time = if use_24h {
            format!("{h:02}:{m:02}")
        } else {
            format!("{}:{m:02} {}", if h % 12 == 0 { 12 } else { h % 12 }, if h < 12 { "AM" } else { "PM" })
        };
        let before = match days {
            d if d <= 0 => "On the day".to_string(),
            1 => "The day before".to_string(),
            7 => "A week before".to_string(),
            d => format!("{d} days before"),
        };
        return format!("{before} at {time}");
    }
    match minutes {
        0 => "At time of event".into(),
        m if m % (7 * 24 * 60) == 0 => format!("{} before", plural(m / (7 * 24 * 60), "week")),
        m if m % (24 * 60) == 0 => format!("{} before", plural(m / (24 * 60), "day")),
        m if m % 60 == 0 => format!("{} before", plural(m / 60, "hour")),
        m => format!("{m} min before"),
    }
}

/// RSVP buckets in Google's order, each with its `--event-N` dot (0 is `--destructive`,
/// `None` is `--muted-foreground`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rsvp {
    Going,
    Maybe,
    NotGoing,
    Awaiting,
}

impl Rsvp {
    pub const ALL: [Rsvp; 4] = [Rsvp::Going, Rsvp::Maybe, Rsvp::NotGoing, Rsvp::Awaiting];

    pub fn of(status: Option<&str>) -> Rsvp {
        match status {
            Some("accepted") => Rsvp::Going,
            Some("tentative") => Rsvp::Maybe,
            Some("declined") => Rsvp::NotGoing,
            _ => Rsvp::Awaiting,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Rsvp::Going => "Going",
            Rsvp::Maybe => "Maybe",
            Rsvp::NotGoing => "Not going",
            Rsvp::Awaiting => "Awaiting",
        }
    }
}

/// Guests split into their buckets, empty ones dropped.
pub fn group_guests(guests: &[Attendee]) -> Vec<(Rsvp, Vec<&Attendee>)> {
    Rsvp::ALL
        .iter()
        .map(|r| (*r, guests.iter().filter(|g| Rsvp::of(g.response_status.as_deref()) == *r).collect::<Vec<_>>()))
        .filter(|(_, g)| !g.is_empty())
        .collect()
}

/// `rsvpSummary`: "3 going, 1 maybe, 2 awaiting".
pub fn rsvp_summary(guests: &[Attendee]) -> String {
    group_guests(guests).iter().map(|(r, g)| format!("{} {}", g.len(), r.label().to_lowercase())).collect::<Vec<_>>().join(", ")
}

/// `avatarColorVar`: the 1-based `--event-N` a guest's avatar uses, stable per email.
pub fn avatar_hue(email: &str) -> usize {
    let mut hash: i32 = 0;
    for unit in email.to_lowercase().encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    ((hash as i64).abs() % 8) as usize + 1
}

/// The first letter of a name, or of the email when there is no name.
pub fn initial(name_or_email: &str) -> String {
    name_or_email.trim().chars().next().map_or("?".into(), |c| c.to_uppercase().collect())
}

/// `htmlToPreviewText`: Google's HTML description as plain text, paragraphs and breaks as
/// single spaces, entities decoded.
pub fn preview_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = out.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Where a location opens: itself when it's a link, else a Google Maps search.
pub fn location_url(location: &str) -> String {
    let lower = location.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return location.to_string();
    }
    let mut url = url::Url::parse("https://www.google.com/maps/search/?api=1").expect("a URL");
    url.query_pairs_mut().append_pair("query", location);
    url.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NY: Tz = chrono_tz::America::New_York;

    fn ms(m: u32, d: u32, h: u32, min: u32) -> f64 {
        NY.with_ymd_and_hms(2026, m, d, h, min, 0).unwrap().timestamp_millis() as f64
    }

    #[test]
    fn time_text_matches_the_web() {
        let e = CalendarEvent { start_ms: ms(11, 11, 15, 0), end_ms: ms(11, 11, 16, 0), ..Default::default() };
        assert_eq!(time_text(&e, NY, false), "Wed 11 Nov, 3:00 PM – 4:00 PM");
        let overnight = CalendarEvent { start_ms: ms(11, 14, 22, 0), end_ms: ms(11, 15, 1, 30), ..Default::default() };
        assert_eq!(time_text(&overnight, NY, true), "Sat 14 Nov, 22:00 – Sun 15 Nov, 01:30");
        let utc = |d: u32| chrono::Utc.with_ymd_and_hms(2026, 11, d, 0, 0, 0).unwrap().timestamp_millis() as f64;
        let trip = CalendarEvent { all_day: true, start_ms: utc(12), end_ms: utc(14), ..Default::default() };
        assert_eq!(time_text(&trip, NY, false), "Thu 12 Nov – Fri 13 Nov");
    }

    #[test]
    fn relative_times_round_like_date_fns() {
        assert_eq!(relative(25.0 * 60_000.0, 0.0), "in 25 minutes");
        assert_eq!(relative(0.0, 2.0 * 86_400_000.0), "2 days ago");
        assert_eq!(relative(90.0 * 60_000.0, 0.0), "in 2 hours");
        assert_eq!(relative(60_000.0, 0.0), "in 1 minute");
    }

    #[test]
    fn reminder_labels() {
        assert_eq!(reminder_label(10.0, false, false), "10 min before");
        assert_eq!(reminder_label(60.0, false, false), "1 hour before");
        assert_eq!(reminder_label(2880.0, false, false), "2 days before");
        assert_eq!(reminder_label(0.0, false, false), "At time of event");
        // 15 hours before an all-day event's midnight is 9:00 AM the day before.
        assert_eq!(reminder_label(900.0, true, false), "The day before at 9:00 AM");
    }

    #[test]
    fn guests_group_by_answer() {
        let g = |s: &str| Attendee { email: format!("{s}@x"), response_status: Some(s.into()), ..Default::default() };
        let guests = vec![g("accepted"), g("needsAction"), g("accepted"), g("declined")];
        assert_eq!(rsvp_summary(&guests), "2 going, 1 not going, 1 awaiting");
        assert!((1..=8).contains(&avatar_hue("ana@example.com")));
        assert_eq!(initial("  sara"), "S");
    }

    #[test]
    fn descriptions_preview_as_plain_text() {
        assert_eq!(preview_text("<p>Bring <b>snacks</b> &amp; notes</p><p>Room&nbsp;3</p>"), "Bring snacks & notes Room 3");
        assert_eq!(location_url("https://zoom.us/j/1"), "https://zoom.us/j/1");
        assert_eq!(location_url("Studio 3, 2nd floor"), "https://www.google.com/maps/search/?api=1&query=Studio+3%2C+2nd+floor");
    }
}
