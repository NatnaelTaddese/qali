//! Event colours, as `apps/web/src/components/calendar/colors.ts` resolves them: Google's
//! event palette key or the calendar's hex, snapped to the nearest hue of the app's
//! `--event-*` palette so every event shares one lightness and chroma band.

use std::collections::HashMap;

use super::models::CalendarEvent;

/// Google Calendar's stable event-colour hexes, by the palette key stored in `event.color`.
pub fn google_event_hex(key: &str) -> Option<&'static str> {
    Some(match key {
        "1" => "#7986cb",
        "2" => "#33b679",
        "3" => "#8e24aa",
        "4" => "#e67c73",
        "5" => "#f6c026",
        "6" => "#f5511d",
        "7" => "#039be5",
        "8" => "#616161",
        "9" => "#3f51b5",
        "10" => "#0b8043",
        "11" => "#d60000",
        _ => return None,
    })
}

/// The `--event-N` hues, in order (globals.css).
pub const PALETTE_HUES: [f32; 8] = [20.0, 50.0, 90.0, 150.0, 195.0, 240.0, 285.0, 325.0];

/// Below this oklch chroma a source colour reads as grey, not as a hue.
const NEUTRAL_CHROMA: f32 = 0.03;

/// A slot in the app palette: `Hue(i)` is `--event-{i + 1}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Swatch {
    Neutral,
    Hue(usize),
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

/// Chroma and hue (degrees) of a `#rrggbb` colour in oklch.
fn chroma_hue(hex: &str) -> Option<(f32, f32)> {
    let digits = hex.trim().strip_prefix('#').unwrap_or(hex.trim());
    if digits.len() != 6 {
        return None;
    }
    let int = u32::from_str_radix(digits, 16).ok()?;
    let channel = |shift: u32| srgb_to_linear(((int >> shift) & 0xff) as f32 / 255.0);
    let (r, g, b) = (channel(16), channel(8), channel(0));
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    let a = 1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s;
    let bb = 0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s;
    Some((a.hypot(bb), (bb.atan2(a).to_degrees() + 360.0) % 360.0))
}

fn hue_distance(a: f32, b: f32) -> f32 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 { 360.0 - d } else { d }
}

/// The palette slot whose hue is closest to `hex`.
pub fn snap(hex: &str) -> Swatch {
    match chroma_hue(hex) {
        Some((chroma, hue)) if chroma >= NEUTRAL_CHROMA => {
            let mut best = 0;
            for i in 1..PALETTE_HUES.len() {
                if hue_distance(hue, PALETTE_HUES[i]) < hue_distance(hue, PALETTE_HUES[best]) {
                    best = i;
                }
            }
            Swatch::Hue(best)
        }
        _ => Swatch::Neutral,
    }
}

/// A deterministic slot for an id with no colour at all (the web's `hashedVar`).
fn hashed(id: &str) -> Swatch {
    let mut hash: i32 = 0;
    for unit in id.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    Swatch::Hue(((hash as i64).abs() % PALETTE_HUES.len() as i64) as usize)
}

/// The event's own colour first, then its calendar's, then a hash of the calendar id.
pub fn event_swatch(event: &CalendarEvent, calendar_colors: &HashMap<String, String>) -> Swatch {
    let own = event.color.as_deref().and_then(google_event_hex);
    let calendar = event.local_calendar_id.as_ref().and_then(|id| calendar_colors.get(id)).map(String::as_str);
    match own.or(calendar) {
        Some(hex) => snap(hex),
        None => hashed(event.local_calendar_id.as_deref().unwrap_or(&event.id)),
    }
}

/// `EVENT_COLOR_CHOICES`: one Google colour key per palette hue it can produce, in palette
/// order, inverted from `snap` over Google's palette (several keys share a hue; first wins).
pub fn color_choices() -> Vec<(&'static str, Swatch)> {
    const KEYS: [&str; 11] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];
    let mut by_swatch: Vec<(Swatch, &'static str)> = Vec::new();
    for key in KEYS {
        let swatch = snap(google_event_hex(key).unwrap());
        if !by_swatch.iter().any(|(s, _)| *s == swatch) {
            by_swatch.push((swatch, key));
        }
    }
    let order = |s: &Swatch| match s {
        Swatch::Hue(i) => *i,
        Swatch::Neutral => usize::MAX,
    };
    by_swatch.sort_by_key(|(s, _)| order(s));
    by_swatch.into_iter().map(|(s, k)| (k, s)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_colours_snap_like_the_web() {
        // Tomato is red (hue ~29°) → --event-1; Peacock is blue (~238°) → --event-6.
        assert_eq!(snap("#d60000"), Swatch::Hue(0));
        assert_eq!(snap("#039be5"), Swatch::Hue(5));
        assert_eq!(snap("#616161"), Swatch::Neutral);
        assert_eq!(snap("not a colour"), Swatch::Neutral);
    }

    #[test]
    fn color_choices_offer_each_hue_once() {
        let choices = color_choices();
        assert!(choices.len() >= 6);
        let swatches: Vec<_> = choices.iter().map(|(_, s)| *s).collect();
        assert!(swatches.windows(2).all(|w| w[0] != w[1]));
        assert_eq!(choices[0], ("4", Swatch::Hue(0)), "Flamingo comes before Tomato, as on the web");
    }

    #[test]
    fn hashing_matches_javascripts_int32_wraparound() {
        // (("a"*31 + "b") | 0) = 3105, 3105 % 8 = 1.
        assert_eq!(hashed("ab"), Swatch::Hue(1));
    }
}
