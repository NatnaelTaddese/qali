import Foundation

// Port of packages/domain/src/calendar/colors.ts.
//
// Google's event colours are a fixed palette of 11 (`color` "1"…"11") and
// calendars carry an arbitrary `backgroundColor` hex. Each source hex is
// converted to oklch and snapped to the nearest hue of the app's `--event-*`
// palette, which shares one lightness/chroma band so the grid reads as one
// system. This module only picks the palette *key*; the app maps it to a colour.

/// The palette keys the apps define: eight hues plus a neutral.
public enum EventPaletteKey: String, CaseIterable, Sendable {
  case event1 = "--event-1"
  case event2 = "--event-2"
  case event3 = "--event-3"
  case event4 = "--event-4"
  case event5 = "--event-5"
  case event6 = "--event-6"
  case event7 = "--event-7"
  case event8 = "--event-8"
  case neutral = "--event-neutral"

  /// 1…8 for the hues, nil for the neutral.
  public var hueIndex: Int? {
    switch self {
    case .neutral: nil
    default: Int(rawValue.dropFirst("--event-".count))
    }
  }

  static func hue(_ index: Int) -> EventPaletteKey {
    EventPaletteKey(rawValue: "--event-\(index + 1)")!
  }
}

/// Google Calendar's stable event-colour hexes, keyed by `event.color`.
let googleEventColors: [String: String] = [
  "1": "#7986cb",  // Lavender
  "2": "#33b679",  // Sage
  "3": "#8e24aa",  // Grape
  "4": "#e67c73",  // Flamingo
  "5": "#f6c026",  // Banana
  "6": "#f5511d",  // Tangerine
  "7": "#039be5",  // Peacock
  "8": "#616161",  // Graphite
  "9": "#3f51b5",  // Blueberry
  "10": "#0b8043",  // Basil
  "11": "#d60000",  // Tomato
]

/// App palette hues, in the same order as the `--event-N` keys.
let paletteHues: [Double] = [20, 50, 90, 150, 195, 240, 285, 325]

/// Below this oklch chroma a source colour reads as grey, not as a hue.
let neutralChroma = 0.03

private func srgbToLinear(_ c: Double) -> Double {
  c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
}

/// Chroma and hue (degrees) of a `#rrggbb` colour in oklch.
func hexToChromaHue(_ hex: String) -> (chroma: Double, hue: Double)? {
  var digits = hex.trimmingCharacters(in: .whitespaces)
  if digits.hasPrefix("#") { digits.removeFirst() }
  guard digits.count == 6, digits.allSatisfy(\.isHexDigit), let int = Int(digits, radix: 16) else {
    return nil
  }
  let r = srgbToLinear(Double((int >> 16) & 0xff) / 255)
  let g = srgbToLinear(Double((int >> 8) & 0xff) / 255)
  let b = srgbToLinear(Double(int & 0xff) / 255)

  // Linear sRGB -> LMS -> Oklab (Björn Ottosson's matrices).
  let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  let labA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  let labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  let hue = (atan2(labB, labA) * (180 / .pi) + 360).truncatingRemainder(dividingBy: 360)
  return (chroma: hypot(labA, labB), hue: hue)
}

/// Shortest distance between two hues on the 360° circle.
private func hueDistance(_ a: Double, _ b: Double) -> Double {
  let d = abs(a - b).truncatingRemainder(dividingBy: 360)
  return d > 180 ? 360 - d : d
}

/// The palette key whose hue is closest to `hex`.
public func snapToPalette(_ hex: String) -> EventPaletteKey {
  guard let oklch = hexToChromaHue(hex), oklch.chroma >= neutralChroma else {
    return .neutral
  }
  var best = 0
  for i in 1..<paletteHues.count
  where hueDistance(oklch.hue, paletteHues[i]) < hueDistance(oklch.hue, paletteHues[best]) {
    best = i
  }
  return .hue(best)
}

/// The colours a create/edit UI can offer, one Google `color` key per palette
/// hue it can actually produce (first Google colour to snap to a hue wins).
public let eventColorChoices: [(color: String, key: EventPaletteKey)] = {
  var byKey: [EventPaletteKey: String] = [:]
  // Object.entries order for integer-like keys is ascending numeric.
  for color in googleEventColors.keys.sorted(by: { Int($0)! < Int($1)! }) {
    let key = snapToPalette(googleEventColors[color]!)
    if byKey[key] == nil { byKey[key] = color }
  }
  return EventPaletteKey.allCases.compactMap { key in byKey[key].map { (color: $0, key: key) } }
}()

/// Deterministic palette entry for an id, used when the provider gave no
/// colour at all. Matches the TypeScript hash bit for bit: 32-bit wrapping
/// `hash * 31 + code`, over each code point's first UTF-16 unit.
func hashedKey(_ id: String) -> EventPaletteKey {
  var hash: Int32 = 0
  for scalar in id.unicodeScalars {
    let code = Int32(String(scalar).utf16.first!)
    hash = hash &* 31 &+ code
  }
  return .hue(Int(Int64(hash).magnitude % UInt64(paletteHues.count)))
}

/// Resolve an event to a palette key: its own `color` first, then its
/// calendar's colour, then a hash of the calendar id. `calendarColors` is keyed
/// by the local calendar id — provider calendar strings collide across
/// connections.
public func eventColorKey(
  _ event: some ColorableEventLike,
  calendarColors: [String: String]? = nil
) -> EventPaletteKey {
  let own = event.color.flatMap { googleEventColors[$0] }
  let hex = own ?? event.localCalendarId.flatMap { calendarColors?[$0] }
  if let hex { return snapToPalette(hex) }
  return hashedKey(event.localCalendarId ?? event.id)
}

/// Palette key for a calendar itself (dots and toggles).
public func calendarColorKey(id: String, backgroundColor: String?) -> EventPaletteKey {
  backgroundColor.map(snapToPalette) ?? hashedKey(id)
}
