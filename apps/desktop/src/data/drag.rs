//! Moving and resizing an event by dragging it, after `calendar/use-event-drag.ts`: past a
//! 4pt threshold a press becomes a drag; the body moves the event (across day columns too),
//! its top and bottom 8pt resize it within its own day, and every time snaps to 15 minutes.

use super::week::SNAP_MS;

/// Travel before a press becomes a drag (`DRAG_THRESHOLD_PX`).
pub const THRESHOLD: f32 = 4.0;
/// How far into a card its edges resize instead of move.
pub const EDGE: f32 = 8.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Move,
    ResizeStart,
    ResizeEnd,
}

impl Mode {
    /// Which gesture a press at `y` (from the card's top) on a card `h` tall starts. A card too
    /// short for both edges and a body only moves.
    pub fn at(y: f32, h: f32) -> Mode {
        if h < EDGE * 3.0 {
            Mode::Move
        } else if y < EDGE {
            Mode::ResizeStart
        } else if y > h - EDGE {
            Mode::ResizeEnd
        } else {
            Mode::Move
        }
    }
}

/// Where the pressed card sits, captured when the drag starts: everything the gesture needs to
/// turn pointer travel into new times.
#[derive(Clone, Debug, PartialEq)]
pub struct Grip {
    pub event_id: String,
    pub mode: Mode,
    pub start_ms: f64,
    pub end_ms: f64,
    /// The page's day starts, plus the midnight after the last day (DST-aware).
    pub day_starts: Vec<f64>,
    /// The column the event is drawn in when pressed.
    pub column: usize,
    /// The pressed point's x within the strip of day columns.
    pub press_x: f32,
    pub col_w: f32,
    /// Points per hour on the grid.
    pub hour_h: f32,
}

fn snap(ms: f64, day_start: f64) -> f64 {
    day_start + ((ms - day_start) / SNAP_MS).round() * SNAP_MS
}

impl Grip {
    fn day(&self, column: usize) -> (f64, f64) {
        (self.day_starts[column], self.day_starts[column + 1])
    }

    /// The times the event would have with the pointer `dx`, `dy` from where it was pressed.
    pub fn times(&self, dx: f32, dy: f32) -> (f64, f64) {
        let ms_per_pt = 3_600_000.0 / self.hour_h as f64;
        let shift = dy as f64 * ms_per_pt;
        let duration = (self.end_ms - self.start_ms).max(SNAP_MS);
        match self.mode {
            Mode::Move => {
                let columns = self.day_starts.len() - 1;
                let column = (((self.press_x + dx) / self.col_w).floor().max(0.0) as usize).min(columns - 1);
                let (from_start, _) = self.day(self.column);
                let (day_start, day_end) = self.day(column);
                // The same wall-clock offset into the target day, moved by the vertical travel.
                let start = snap(day_start + (self.start_ms - from_start) + shift, day_start);
                let start = start.clamp(day_start, (day_end - duration).max(day_start));
                (start, start + duration)
            }
            Mode::ResizeStart => {
                let (day_start, day_end) = self.day(self.column);
                let pointer = snap(self.start_ms + shift, day_start).clamp(day_start, day_end);
                (pointer.min(self.end_ms - SNAP_MS), self.end_ms)
            }
            Mode::ResizeEnd => {
                let (day_start, day_end) = self.day(self.column);
                let pointer = snap(self.end_ms + shift, day_start).clamp(day_start, day_end);
                (self.start_ms, pointer.max(self.start_ms + SNAP_MS))
            }
        }
    }
}

/// A drag in progress.
#[derive(Clone, Debug, PartialEq)]
pub struct EventDrag {
    pub grip: Grip,
    /// Past the threshold: it's a drag, not a click.
    pub moved: bool,
    /// The times the event would land on now.
    pub start_ms: f64,
    pub end_ms: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: f64 = 3_600_000.0;

    /// A Monday-to-Wednesday page with 40pt hours and 100pt columns, holding 10:00–11:00 on
    /// Tuesday, pressed 20pt into its column.
    fn grip(mode: Mode) -> Grip {
        let day = 24.0 * H;
        Grip {
            event_id: "e".into(),
            mode,
            start_ms: day + 10.0 * H,
            end_ms: day + 11.0 * H,
            day_starts: vec![0.0, day, 2.0 * day, 3.0 * day],
            column: 1,
            press_x: 100.0 + 20.0,
            col_w: 100.0,
            hour_h: 40.0,
        }
    }

    #[test]
    fn presses_pick_the_gesture_by_where_they_land() {
        assert_eq!(Mode::at(3.0, 40.0), Mode::ResizeStart);
        assert_eq!(Mode::at(36.0, 40.0), Mode::ResizeEnd);
        assert_eq!(Mode::at(20.0, 40.0), Mode::Move);
        assert_eq!(Mode::at(2.0, 20.0), Mode::Move, "too short for edges");
    }

    #[test]
    fn moving_snaps_to_quarter_hours_and_crosses_days() {
        let g = grip(Mode::Move);
        let day = 24.0 * H;
        // 27pt down is 40.5 minutes: snaps to 45.
        assert_eq!(g.times(0.0, 27.0), (day + 10.75 * H, day + 11.75 * H));
        // One column right, an hour up.
        assert_eq!(g.times(100.0, -40.0), (2.0 * day + 9.0 * H, 2.0 * day + 10.0 * H));
        // Past the last column it stays on the last day, and it can't leave the day's bottom.
        assert_eq!(g.times(900.0, 2000.0), (3.0 * day - H, 3.0 * day));
    }

    #[test]
    fn resizing_keeps_a_quarter_hour_and_its_day() {
        let day = 24.0 * H;
        assert_eq!(grip(Mode::ResizeEnd).times(0.0, 20.0), (day + 10.0 * H, day + 11.5 * H));
        assert_eq!(grip(Mode::ResizeEnd).times(0.0, -400.0), (day + 10.0 * H, day + 10.25 * H), "never shorter than 15 minutes");
        assert_eq!(grip(Mode::ResizeStart).times(0.0, -10.0), (day + 9.75 * H, day + 11.0 * H));
        assert_eq!(grip(Mode::ResizeStart).times(0.0, -9999.0), (day, day + 11.0 * H), "stops at midnight");
    }
}
