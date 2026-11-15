import Foundation

// Port of packages/domain/src/calendar/now.ts.

public struct NowIndicatorLayout: Equatable, Sendable {
  public struct Today: Equatable, Sendable {
    /// Today's index into the `days` the layout was computed from.
    public var todayIndex: Int
    /// Today's left edge within the full strip (0–100).
    public var leftPct: Double
    /// One column's width within the full strip (0–100).
    public var widthPct: Double
  }

  /// Vertical position within the 24-hour body (0–100).
  public var topPct: Double
  /// Today's column within the full buffered strip, when it is in view.
  public var today: Today?
}

/// Indicator geometry: a full-width line at the current time, plus today's
/// column when it falls inside the strip. `zone` is the working zone the
/// `days` were cut in, so "now" is read on the same clock.
public func nowIndicatorLayout(days: [Date], nowMs: Double, zone: WorkingZone) -> NowIndicatorLayout? {
  guard !days.isEmpty else { return nil }
  let now = Date(ms: nowMs)
  let todayIndex = days.firstIndex { zone.isSameDay($0, now) }
  return NowIndicatorLayout(
    topPct: msToPct(nowMs, dayStartMs: zone.startOfDay(now).ms),
    today: todayIndex.map { index in
      .init(
        todayIndex: index,
        leftPct: Double(index) / Double(days.count) * 100,
        widthPct: 1 / Double(days.count) * 100
      )
    }
  )
}
