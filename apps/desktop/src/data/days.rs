//! Days in the working time zone (the zone the user picked in settings, else the Mac's), as
//! the web calendar cuts them with `zoned()`.

use chrono::{DateTime, Duration, NaiveDate, TimeZone};
use chrono_tz::Tz;

/// The working zone: the preference when it names a real zone, else the system's, else UTC.
pub fn working_zone(preference: Option<&str>) -> Tz {
    preference
        .and_then(|name| name.parse().ok())
        .or_else(|| iana_time_zone::get_timezone().ok().and_then(|name| name.parse().ok()))
        .unwrap_or(Tz::UTC)
}

fn at(ms: f64, zone: Tz) -> DateTime<Tz> {
    zone.timestamp_millis_opt(ms as i64).earliest().unwrap_or_else(|| zone.timestamp_millis_opt(0).unwrap())
}

/// Midnight of `date` in `zone`, as epoch milliseconds. On a day that starts inside a DST gap,
/// the first instant that exists.
pub fn start_of_day_ms(date: NaiveDate, zone: Tz) -> f64 {
    let mut probe = date.and_hms_opt(0, 0, 0).unwrap();
    loop {
        if let Some(t) = zone.from_local_datetime(&probe).earliest() {
            return t.timestamp_millis() as f64;
        }
        probe += Duration::minutes(15);
    }
}

/// The calendar date `ms` falls on in `zone`.
pub fn today(now_ms: f64, zone: Tz) -> NaiveDate {
    at(now_ms, zone).date_naive()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NY: Tz = chrono_tz::America::New_York;
    const SAO_PAULO: Tz = chrono_tz::America::Sao_Paulo;

    #[test]
    fn days_start_at_local_midnight_and_skip_a_dst_gap() {
        let d = NaiveDate::from_ymd_opt(2026, 11, 1).unwrap();
        let expect = NY.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap().timestamp_millis() as f64;
        assert_eq!(start_of_day_ms(d, NY), expect);
        // São Paulo moved its clocks at midnight in 2018, so 4 Nov 2018 began at 01:00.
        let gap = NaiveDate::from_ymd_opt(2018, 11, 4).unwrap();
        let first = SAO_PAULO.with_ymd_and_hms(2018, 11, 4, 1, 0, 0).unwrap().timestamp_millis() as f64;
        assert_eq!(start_of_day_ms(gap, SAO_PAULO), first);
    }

    #[test]
    fn today_is_read_in_the_zone() {
        // 03:30 UTC on the 11th is still the 10th in New York.
        let ms = chrono::Utc.with_ymd_and_hms(2026, 11, 11, 3, 30, 0).unwrap().timestamp_millis() as f64;
        assert_eq!(today(ms, NY), NaiveDate::from_ymd_opt(2026, 11, 10).unwrap());
    }

    #[test]
    fn an_unknown_zone_preference_falls_back() {
        assert_eq!(working_zone(Some("Europe/Berlin")), chrono_tz::Europe::Berlin);
        let _ = working_zone(Some("Not/AZone"));
    }
}
