import Foundation

// Port of packages/domain/src/calendar/time.ts. Instants are epoch
// milliseconds as `Double`, exactly as the backend returns them and as the
// TypeScript math uses them, so ported arithmetic and tests stay one-to-one.

public let msPerMinute: Double = 60_000
public let msPerHour: Double = 60 * msPerMinute
public let msPerDay: Double = 24 * msPerHour

/// The grid's time resolution: drags, drafts and free-slot search snap to it.
public let snapMinutes: Double = 15
public let snapMs: Double = snapMinutes * msPerMinute

/// The default time a freshly created event starts on a day with no better
/// cue (9:00 AM).
public let defaultEventStartMinutes: Double = 9 * 60
/// New events default to a half-hour block.
public let defaultEventDurationMs: Double = 30 * msPerMinute

/// Vertical position of an instant as a percentage (0–100) of the day height.
public func msToPct(_ ms: Double, dayStartMs: Double) -> Double {
  (ms - dayStartMs) / msPerDay * 100
}

extension Date {
  /// An instant from epoch milliseconds.
  public init(ms: Double) {
    self.init(timeIntervalSince1970: ms / 1000)
  }

  /// Epoch milliseconds, rounded so a `Date(ms:)` round trip is exact.
  public var ms: Double {
    (timeIntervalSince1970 * 1000).rounded()
  }
}
