import Foundation
import QaliDomain

/// "Weekly on Mon, Wed · 5 times": a repeating event's rule in words (the
/// web's `parseRRule` + `summarize`). Only the subset the app can describe is
/// read; anything else gives nil, and the detail says "Part of a repeating
/// series" instead.
nonisolated enum RecurrenceSummary {
  static func summarize(_ lines: [String], zone: WorkingZone) -> String? {
    Recurrence.parse(lines, zone: zone)?.summary(zone: zone)
  }
}
