//! Which page of the calendar is showing (`CalendarView`, `pageStart`, `addPages`, `pageDays`,
//! `viewTitle` in the web's lib.ts), and the event range a page needs loaded.

use chrono::{Datelike, Duration, Months, NaiveDate};
use chrono_tz::Tz;

use super::days::start_of_day_ms;
use super::week::week_start;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum View {
    Day,
    #[default]
    Week,
    Month,
}

impl View {
    pub const ALL: [View; 3] = [View::Day, View::Week, View::Month];

    pub fn label(self) -> &'static str {
        match self {
            View::Day => "Day",
            View::Week => "Week",
            View::Month => "Month",
        }
    }
}

/// The first day of the page holding `date`.
pub fn page_start(view: View, date: NaiveDate, week_starts_on: u32) -> NaiveDate {
    match view {
        View::Day => date,
        View::Week => week_start(date, week_starts_on),
        View::Month => date.with_day(1).unwrap(),
    }
}

/// `start` moved by `n` pages (days, weeks or months).
pub fn add_pages(view: View, start: NaiveDate, n: i32) -> NaiveDate {
    match view {
        View::Day => start + Duration::days(n as i64),
        View::Week => start + Duration::weeks(n as i64),
        View::Month if n >= 0 => start + Months::new(n as u32),
        View::Month => start - Months::new(n.unsigned_abs()),
    }
}

/// The days a page draws: one, seven, or the month's fixed 6×7 grid.
pub fn page_days(view: View, start: NaiveDate, week_starts_on: u32) -> Vec<NaiveDate> {
    let (first, count) = match view {
        View::Day => (start, 1),
        View::Week => (start, 7),
        View::Month => (week_start(start, week_starts_on), 42),
    };
    (0..count).map(|i| first + Duration::days(i)).collect()
}

/// The range to load for a page: its days plus a week either side, so stepping to a
/// neighbouring day or week finds its events already there.
pub fn query_range(view: View, start: NaiveDate, zone: Tz, week_starts_on: u32) -> (f64, f64) {
    let days = page_days(view, start, week_starts_on);
    let first = days[0] - Duration::days(7);
    let last = *days.last().unwrap() + Duration::days(8);
    (start_of_day_ms(first, zone), start_of_day_ms(last, zone))
}

/// Whether `inner` lies inside `outer` (both `[start, end)` in ms).
pub fn covers(outer: (f64, f64), inner: (f64, f64)) -> bool {
    outer.0 <= inner.0 && inner.1 <= outer.1
}

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
pub const WEEKDAYS_SHORT: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

pub fn weekday_short(d: NaiveDate) -> &'static str {
    WEEKDAYS_SHORT[d.weekday().num_days_from_monday() as usize]
}

/// `viewTitle`: "Wednesday, Nov 11, 2026", "November 2026", or across a month boundary
/// "Nov – Dec 2026".
pub fn title(view: View, start: NaiveDate) -> String {
    let month = |d: NaiveDate| MONTHS[d.month0() as usize];
    let short = |d: NaiveDate| MONTHS_SHORT[d.month0() as usize];
    match view {
        View::Day => format!("{}, {} {}, {}", WEEKDAYS[start.weekday().num_days_from_monday() as usize], short(start), start.day(), start.year()),
        View::Month => format!("{} {}", month(start), start.year()),
        View::Week => {
            let last = start + Duration::days(6);
            if start.month() == last.month() && start.year() == last.year() {
                format!("{} {}", month(start), start.year())
            } else if start.year() == last.year() {
                format!("{} – {} {}", short(start), short(last), last.year())
            } else {
                format!("{} {} – {} {}", short(start), start.year(), short(last), last.year())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn pages_start_and_step_per_view() {
        let wed = d(2026, 11, 11);
        assert_eq!(page_start(View::Day, wed, 1), wed);
        assert_eq!(page_start(View::Week, wed, 1), d(2026, 11, 9));
        assert_eq!(page_start(View::Month, wed, 1), d(2026, 11, 1));
        assert_eq!(add_pages(View::Day, wed, -1), d(2026, 11, 10));
        assert_eq!(add_pages(View::Week, d(2026, 11, 9), 1), d(2026, 11, 16));
        assert_eq!(add_pages(View::Month, d(2026, 11, 1), 2), d(2027, 1, 1));
        assert_eq!(add_pages(View::Month, d(2026, 1, 1), -1), d(2025, 12, 1));
    }

    #[test]
    fn a_month_page_is_six_weeks_from_the_week_start() {
        let days = page_days(View::Month, d(2026, 11, 1), 1);
        assert_eq!(days.len(), 42);
        assert_eq!(days[0], d(2026, 10, 26), "the Monday before Sunday 1 Nov");
        assert_eq!(days[41], d(2026, 12, 6));
    }

    #[test]
    fn titles_follow_the_web() {
        assert_eq!(title(View::Week, d(2026, 11, 9)), "November 2026");
        assert_eq!(title(View::Week, d(2026, 11, 30)), "Nov – Dec 2026");
        assert_eq!(title(View::Week, d(2026, 12, 28)), "Dec 2026 – Jan 2027");
        assert_eq!(title(View::Day, d(2026, 11, 11)), "Wednesday, Nov 11, 2026");
        assert_eq!(title(View::Month, d(2026, 11, 1)), "November 2026");
    }

    #[test]
    fn a_loaded_range_covers_the_neighbouring_week() {
        let ny = chrono_tz::America::New_York;
        let loaded = query_range(View::Week, d(2026, 11, 9), ny, 1);
        let next_week_days = (start_of_day_ms(d(2026, 11, 16), ny), start_of_day_ms(d(2026, 11, 23), ny));
        assert!(covers(loaded, next_week_days));
        assert!(!covers(loaded, (start_of_day_ms(d(2026, 11, 23), ny), start_of_day_ms(d(2026, 11, 30), ny))));
    }
}
