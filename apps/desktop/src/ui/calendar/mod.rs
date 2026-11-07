//! The week grid, after `apps/web/src/components/calendar`: the toolbar, the date row and
//! all-day band (`PanelHeader`), the hour gutter (`GutterColumn`), day columns of event cards
//! (`DayColumn`, `EventCard`) and the now line (`NowIndicator`).

pub mod day_column;
pub mod event_block;
pub mod gutter;
pub mod home;
pub mod month_view;
pub mod panel_header;
pub mod toolbar;

use chrono::{Datelike, NaiveDate};

/// `MIN_HOUR_HEIGHT`: the web grid's 40px hour, which is what it shows below ~1000px tall.
pub const HOUR_H: f32 = 40.0;
pub const DAY_H: f32 = 24.0 * HOUR_H;
/// `GUTTER_WIDTH`.
pub const GUTTER_W: f32 = 64.0;
/// `HEADER_DATE_HEIGHT`: the weekday/date row.
pub const HEADER_DATE_H: f32 = 44.0;
/// `EVENT_LEFT_GUTTER_PX`: a strip left free on each column, beside its cards.
pub const EVENT_LEFT_GUTTER: f32 = 12.0;
/// `TIME_GRID_BOTTOM_SPACER_HEIGHT`: room under 11 PM so the island never covers events.
pub const BOTTOM_SPACER: f32 = 96.0;
/// The scroll container's key, for `Tx::scroll_to_instant`.
pub const SCROLL_KEY: &str = "week-scroll";

/// The ISO week number the web shows beside the title (`getISOWeek`).
pub fn iso_week(day: NaiveDate) -> u32 {
    day.iso_week().week()
}

/// The `h:mm` / `HH:mm` clock the cards and the now pill use (`timePattern`).
pub fn clock(ms: f64, zone: chrono_tz::Tz, use_24h: bool, day_period: bool) -> String {
    use chrono::{TimeZone, Timelike};
    let t = zone.timestamp_millis_opt(ms as i64).earliest().unwrap_or_else(|| zone.timestamp_millis_opt(0).unwrap());
    if use_24h {
        return format!("{:02}:{:02}", t.hour(), t.minute());
    }
    let (pm, hour) = t.hour12();
    let base = format!("{hour}:{:02}", t.minute());
    if day_period { format!("{base} {}", if pm { "PM" } else { "AM" }) } else { base }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn week_numbers_are_iso() {
        assert_eq!(iso_week(NaiveDate::from_ymd_opt(2026, 11, 9).unwrap()), 46);
        assert_eq!(iso_week(NaiveDate::from_ymd_opt(2027, 1, 1).unwrap()), 53);
    }
}
