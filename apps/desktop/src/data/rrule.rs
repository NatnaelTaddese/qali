//! Repeat rules, after `calendar/rrule.ts`: a typed model the form edits, the one RRULE line
//! Google takes, and the short summary the form shows. Rules are only ever written: synced
//! events are expanded instances that never carry their own.

use chrono::{Datelike, NaiveDate, TimeZone};
use chrono_tz::Tz;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Freq {
    pub const ALL: [Freq; 4] = [Freq::Daily, Freq::Weekly, Freq::Monthly, Freq::Yearly];

    fn code(self) -> &'static str {
        match self {
            Freq::Daily => "DAILY",
            Freq::Weekly => "WEEKLY",
            Freq::Monthly => "MONTHLY",
            Freq::Yearly => "YEARLY",
        }
    }

    /// The custom editor's tab label.
    pub fn label(self) -> &'static str {
        match self {
            Freq::Daily => "Day",
            Freq::Weekly => "Week",
            Freq::Monthly => "Month",
            Freq::Yearly => "Year",
        }
    }

    fn adverb(self) -> &'static str {
        match self {
            Freq::Daily => "Daily",
            Freq::Weekly => "Weekly",
            Freq::Monthly => "Monthly",
            Freq::Yearly => "Annually",
        }
    }
}

/// RRULE weekday codes, Monday first as the grid draws them.
pub const WEEKDAYS: [&str; 7] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WEEKDAY_LABELS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
pub const WEEKDAY_INITIALS: [&str; 7] = ["M", "T", "W", "T", "F", "S", "S"];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum End {
    Never,
    /// Until and including this calendar day.
    OnDate(NaiveDate),
    Count(u32),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Recurrence {
    pub freq: Freq,
    /// "Every N", at least 1.
    pub interval: u32,
    /// Weekly only: indices into `WEEKDAYS`, kept sorted.
    pub weekdays: Vec<usize>,
    pub end: End,
}

/// The weekday index (Monday 0) `ms` falls on in `zone`.
pub fn weekday_of(ms: f64, zone: Tz) -> usize {
    crate::data::days::today(ms, zone).weekday().num_days_from_monday() as usize
}

impl Recurrence {
    fn simple(freq: Freq) -> Recurrence {
        Recurrence { freq, interval: 1, weekdays: Vec::new(), end: End::Never }
    }

    /// Weekly on the start's day: the custom editor's starting point.
    pub fn weekly_on(start_ms: f64, zone: Tz) -> Recurrence {
        Recurrence { weekdays: vec![weekday_of(start_ms, zone)], ..Recurrence::simple(Freq::Weekly) }
    }

    /// The Google `recurrence` lines (one RRULE). UNTIL stamps the end of the chosen day in
    /// `zone` as a UTC instant, as Google does, so every occurrence that day counts.
    pub fn to_rrule(&self, zone: Tz) -> Vec<String> {
        let mut parts = vec![format!("FREQ={}", self.freq.code())];
        if self.interval > 1 {
            parts.push(format!("INTERVAL={}", self.interval));
        }
        if self.freq == Freq::Weekly && !self.weekdays.is_empty() {
            let days: Vec<_> = self.weekdays.iter().map(|&i| WEEKDAYS[i]).collect();
            parts.push(format!("BYDAY={}", days.join(",")));
        }
        match self.end {
            End::Never => {}
            End::Count(n) => parts.push(format!("COUNT={}", n.max(1))),
            End::OnDate(day) => {
                let last = day.and_hms_opt(23, 59, 59).unwrap();
                let instant = zone.from_local_datetime(&last).earliest().map_or(last.and_utc(), |t| t.to_utc());
                parts.push(format!("UNTIL={}", instant.format("%Y%m%dT%H%M%SZ")));
            }
        }
        vec![format!("RRULE:{}", parts.join(";"))]
    }

    /// "Weekly on Mon, Wed · 5 times".
    pub fn summary(&self) -> String {
        let noun = self.freq.label().to_lowercase();
        let mut text = if self.interval > 1 { format!("Every {} {noun}s", self.interval) } else { self.freq.adverb().to_string() };
        if self.freq == Freq::Weekly && !self.weekdays.is_empty() {
            let days: Vec<_> = self.weekdays.iter().map(|&i| WEEKDAY_LABELS[i]).collect();
            text += &format!(" on {}", days.join(", "));
        }
        match self.end {
            End::Never => {}
            End::Count(n) => text += &format!(" · {n} time{}", if n == 1 { "" } else { "s" }),
            End::OnDate(day) => text += &format!(" · until {}", day.format("%b %-d, %Y")),
        }
        text
    }

    /// Toggle a weekday, never leaving a weekly rule with none.
    pub fn toggle_weekday(&mut self, day: usize) {
        if let Some(i) = self.weekdays.iter().position(|&d| d == day) {
            if self.weekdays.len() > 1 {
                self.weekdays.remove(i);
            }
        } else {
            self.weekdays.push(day);
            self.weekdays.sort_unstable();
        }
    }

    /// Switch frequency; weekly keeps its days or takes the start's.
    pub fn set_freq(&mut self, freq: Freq, start_ms: f64, zone: Tz) {
        self.freq = freq;
        if freq == Freq::Weekly {
            if self.weekdays.is_empty() {
                self.weekdays = vec![weekday_of(start_ms, zone)];
            }
        } else {
            self.weekdays.clear();
        }
    }

    /// Whether `self` is exactly what a preset describes (for highlighting it).
    pub fn is(&self, preset: &Recurrence) -> bool {
        self.freq == preset.freq && self.interval == preset.interval && self.end == End::Never && self.weekdays == preset.weekdays
    }
}

/// The repeat menu's presets (`PRESETS`), after "Does not repeat".
pub fn presets(start_ms: f64, zone: Tz) -> Vec<(&'static str, Recurrence)> {
    vec![
        ("Daily", Recurrence::simple(Freq::Daily)),
        ("Weekly", Recurrence::weekly_on(start_ms, zone)),
        ("Weekdays", Recurrence { weekdays: vec![0, 1, 2, 3, 4], ..Recurrence::simple(Freq::Weekly) }),
        ("Monthly", Recurrence::simple(Freq::Monthly)),
        ("Annually", Recurrence::simple(Freq::Yearly)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const NY: Tz = chrono_tz::America::New_York;

    #[test]
    fn rules_match_the_web() {
        let mut r = Recurrence { freq: Freq::Weekly, interval: 2, weekdays: vec![2, 0], end: End::Count(5) };
        r.weekdays.sort_unstable();
        assert_eq!(r.to_rrule(NY), ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5"]);
        assert_eq!(r.summary(), "Every 2 weeks on Mon, Wed · 5 times");
        let until = Recurrence { end: End::OnDate(NaiveDate::from_ymd_opt(2026, 8, 26).unwrap()), ..Recurrence::simple(Freq::Daily) };
        // New York's 26 Aug ends at 03:59:59 UTC the next day, as Google writes it.
        assert_eq!(until.to_rrule(NY), ["RRULE:FREQ=DAILY;UNTIL=20260827T035959Z"]);
        assert_eq!(until.summary(), "Daily · until Aug 26, 2026");
        assert_eq!(Recurrence::simple(Freq::Yearly).summary(), "Annually");
    }

    #[test]
    fn weekly_rules_keep_a_day() {
        let wed = NY.with_ymd_and_hms(2026, 11, 11, 15, 0, 0).unwrap().timestamp_millis() as f64;
        let mut r = Recurrence::weekly_on(wed, NY);
        assert_eq!(r.weekdays, [2]);
        r.toggle_weekday(2);
        assert_eq!(r.weekdays, [2], "the last day stays");
        r.toggle_weekday(0);
        assert_eq!(r.weekdays, [0, 2]);
        r.set_freq(Freq::Monthly, wed, NY);
        assert!(r.weekdays.is_empty());
        r.set_freq(Freq::Weekly, wed, NY);
        assert_eq!(r.weekdays, [2]);
        assert!(r.is(&presets(wed, NY)[1].1));
    }
}
