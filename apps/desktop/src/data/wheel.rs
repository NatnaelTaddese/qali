//! The wheel picker's drum and physics, after `@qali/ui`'s `motion/wheel-picker.tsx`. Rows sit
//! on a cylinder: row `i` at scroll position `s` (a float row index) is `(i - s) · angle` off
//! the front, drawn `radius · sin θ` from the middle, shrinking and fading as it turns away,
//! and dropped once it passes the horizon. A flick coasts on a constant deceleration and
//! lands on a whole row with a small overshoot.

/// Rows visible through the window (`visibleCount`).
pub const VISIBLE: usize = 5;
/// Row height in points (`itemHeight`).
pub const ITEM_H: f32 = 32.0;
/// Rows per ms², how fast a flick bleeds off.
const DECELERATION: f64 = 0.000_42;
/// Rows per ms, caps a hard fling.
const MAX_VELOCITY: f64 = 0.18;
/// Ms of recent drag a release velocity averages over.
pub const VELOCITY_WINDOW_MS: f64 = 90.0;
/// Ms of wheel quiet before snapping to a row.
pub const WHEEL_SETTLE_MS: f64 = 110.0;
/// How far the snap drifts past its row (`BACK`).
const BACK: f64 = 1.35;
/// The shortest snap, so a release right on a row still settles visibly.
const MIN_SNAP_MS: f64 = 180.0;

pub struct Geometry {
    /// Degrees each row spans on the drum.
    pub angle: f32,
    pub radius: f32,
    /// Rows past this many from the front are behind the horizon.
    pub hide_beyond: f32,
    /// The window's height.
    pub height: f32,
}

pub fn geometry() -> Geometry {
    let each_side = (VISIBLE / 2).max(1) as f32;
    let cutoff = each_side + 1.0;
    let angle = 90.0 / cutoff;
    let radius = ITEM_H / angle.to_radians().tan();
    Geometry { angle, radius, hide_beyond: cutoff, height: (2.0 * radius * (each_side * angle).to_radians().sin() + ITEM_H).round() }
}

/// Where row `i` draws with the drum at `s`: its centre's offset from the window's middle,
/// its scale, and its opacity; `None` behind the horizon.
pub fn pose(g: &Geometry, i: usize, s: f32) -> Option<(f32, f32, f32)> {
    let rows = i as f32 - s;
    if rows.abs() > g.hide_beyond {
        return None;
    }
    let theta = (rows * g.angle).to_radians();
    let cos = theta.cos().max(0.0);
    // A drum row foreshortens vertically; a uniform scale can't squash only the height, so it
    // shrinks a little and the fade does the rest, as the web's edge mask does.
    Some((g.radius * theta.sin(), 0.82 + 0.18 * cos, cos * cos))
}

pub fn ease_out_back(p: f64) -> f64 {
    1.0 + (BACK + 1.0) * (p - 1.0).powi(3) + BACK * (p - 1.0).powi(2)
}

/// A settle in progress: from a scroll position to a whole row.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settle {
    pub from: f32,
    pub to: usize,
    pub start: f64,
    pub duration_ms: f64,
}

impl Settle {
    /// Where the drum is `now` (seconds), and whether it has landed.
    pub fn at(&self, now: f64) -> (f32, bool) {
        let p = ((now - self.start) * 1000.0 / self.duration_ms).clamp(0.0, 1.0);
        let s = self.from as f64 + (self.to as f64 - self.from as f64) * ease_out_back(p);
        (s as f32, p >= 1.0)
    }
}

/// A release at `s` moving `velocity` rows/ms: where it coasts to (a whole row inside
/// `0..=last`) and how long it takes.
pub fn fling(s: f32, velocity: f64, last: usize, now: f64) -> Settle {
    let v = velocity.clamp(-MAX_VELOCITY, MAX_VELOCITY);
    let travel = v * v.abs() / (2.0 * DECELERATION);
    let to = (s as f64 + travel).round().clamp(0.0, last as f64) as usize;
    let coast = v.abs() / DECELERATION;
    Settle { from: s, to, start: now, duration_ms: coast.max(MIN_SNAP_MS) }
}

/// Rows per ms over the samples (clock seconds, scroll position) from the last
/// `VELOCITY_WINDOW_MS` before `now`: a drag held still before release doesn't fling.
pub fn velocity(samples: &[(f64, f32)], now: f64) -> f64 {
    let recent: Vec<_> = samples.iter().filter(|(t, _)| (now - t) * 1000.0 <= VELOCITY_WINDOW_MS).collect();
    match (recent.first(), recent.last()) {
        (Some(&&(t0, s0)), Some(&&(t1, s1))) if t1 > t0 => (s1 - s0) as f64 / ((t1 - t0) * 1000.0),
        _ => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_drum_matches_the_web_geometry() {
        let g = geometry();
        // Five rows: 30° each, radius 32 / tan 30°, 2·r·sin 60° + 32 tall.
        assert_eq!(g.angle, 30.0);
        assert!((g.radius - 55.43).abs() < 0.01);
        assert_eq!(g.height, 128.0);
        assert_eq!(pose(&g, 4, 4.0), Some((0.0, 1.0, 1.0)), "the selected row sits flat in the middle");
        let (y, scale, opacity) = pose(&g, 5, 4.0).unwrap();
        assert!((y - 27.7).abs() < 0.1 && scale < 1.0 && opacity < 1.0, "the next row curves away below");
        assert!(pose(&g, 8, 4.0).is_none(), "past the horizon");
    }

    #[test]
    fn a_fling_coasts_and_lands_on_a_row() {
        let still = fling(3.4, 0.0, 11, 0.0);
        assert_eq!((still.to, still.duration_ms), (3, MIN_SNAP_MS));
        let fast = fling(3.0, 0.1, 11, 0.0);
        assert_eq!(fast.to, 11, "0.1 rows/ms coasts about 12 rows, held at the end");
        assert_eq!(fling(3.0, -0.05, 11, 0.0).to, 0);
        let (s, done) = fast.at(fast.duration_ms / 1000.0);
        assert!(done && (s - 11.0).abs() < 1e-4);
        let (mid, _) = still.at(0.09);
        assert!(mid < 3.4 && mid > 2.9, "on its way: {mid}");
        assert!(Settle { from: 3.0, to: 4, start: 0.0, duration_ms: 200.0 }.at(0.15).0 > 4.0, "it overshoots a little");
    }

    #[test]
    fn velocity_averages_the_recent_drag() {
        assert_eq!(velocity(&[], 1.0), 0.0);
        let samples = [(0.0, 0.0), (0.5, 1.0), (0.55, 2.0), (0.6, 3.0)];
        let v = velocity(&samples, 0.6);
        assert!((v - 0.02).abs() < 1e-9, "one row over the 50 ms inside the window: {v}");
        assert_eq!(velocity(&samples, 1.0), 0.0, "held still before letting go");
    }
}
