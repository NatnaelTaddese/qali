import AppKit
import QaliDomain

/// The trackpad taps a drag plays, and how. macOS only offers three patterns
/// with no strength of their own (the trackpad's Click setting scales them
/// all), so the tuning is which pattern each moment gets, how often a moving
/// card taps, and how taps are spaced.
///
/// While these are being tuned, Debug builds read each knob from
/// UserDefaults (`hapticTune.*`, set from Settings › General › Haptics
/// tuning); Release builds use the defaults below.
enum DragHaptics {
  /// What happened in the drag.
  enum Moment: Equatable {
    /// The drag started.
    case pickUp
    /// A moving card stepped to another time.
    case snap
    /// A moving card crossed into another day.
    case day
    /// A dragged edge stepped to another time.
    case resize
    /// The card was let go somewhere new.
    case drop
  }

  enum Pattern: String, CaseIterable, Identifiable {
    case off, generic, alignment, levelChange
    var id: String { rawValue }

    var label: String {
      switch self {
      case .off: "Off"
      case .generic: "Generic"
      case .alignment: "Alignment"
      case .levelChange: "Level change"
      }
    }

    var system: NSHapticFeedbackManager.FeedbackPattern? {
      switch self {
      case .off: nil
      case .generic: .generic
      case .alignment: .alignment
      case .levelChange: .levelChange
      }
    }
  }

  struct Tuning: Equatable {
    var pickUp = Pattern.off
    var snap = Pattern.alignment
    var day = Pattern.levelChange
    var resize = Pattern.alignment
    var drop = Pattern.off
    /// A moving or resized card taps when it reaches (or jumps past) a
    /// multiple of this many minutes into the day; the grid snaps to 15.
    var stepMinutes = 15
    /// Snaps closer together than this are skipped, so a fast drag doesn't
    /// buzz. Day changes always play.
    var minimumGapMs = 0.0
    /// A second day-change tap this long after the first, for a firmer
    /// knock; 0 plays just one.
    var dayEchoMs = 0.0
    /// Times the tap to the next drawn frame, when the card is seen to
    /// land, rather than the moment the pointer moves.
    var onFrame = false

    func pattern(for moment: Moment) -> Pattern {
      switch moment {
      case .pickUp: pickUp
      case .snap: snap
      case .day: day
      case .resize: resize
      case .drop: drop
      }
    }

    static let prefix = "hapticTune."

    static var current: Tuning {
      #if DEBUG
        let defaults = UserDefaults.standard
        func pattern(_ key: String, _ fallback: Pattern) -> Pattern {
          defaults.string(forKey: prefix + key).flatMap(Pattern.init(rawValue:)) ?? fallback
        }
        func number(_ key: String, _ fallback: Double) -> Double {
          defaults.object(forKey: prefix + key) as? Double ?? fallback
        }
        let base = Tuning()
        return Tuning(
          pickUp: pattern("pickUp", base.pickUp),
          snap: pattern("snap", base.snap),
          day: pattern("day", base.day),
          resize: pattern("resize", base.resize),
          drop: pattern("drop", base.drop),
          stepMinutes: max(Int(number("stepMinutes", Double(base.stepMinutes))), 15),
          minimumGapMs: number("minimumGapMs", base.minimumGapMs),
          dayEchoMs: number("dayEchoMs", base.dayEchoMs),
          onFrame: defaults.object(forKey: prefix + "onFrame") as? Bool ?? base.onFrame
        )
      #else
        return Tuning()
      #endif
    }
  }

  /// Whether a card edge going from `before` to `after` reached or jumped
  /// past a multiple of `step` minutes into its day.
  static func crossesStep(from before: Double, to after: Double, stepMinutes: Int, zone: WorkingZone) -> Bool {
    let step = Double(stepMinutes)
    let from = minuteOfDay(before, zone), to = minuteOfDay(after, zone)
    if to > from { return (to / step).rounded(.down) > (from / step).rounded(.down) }
    if to < from { return (to / step).rounded(.up) < (from / step).rounded(.up) }
    return false
  }

  private static func minuteOfDay(_ ms: Double, _ zone: WorkingZone) -> Double {
    (ms - zone.startOfDay(Date(ms: ms)).ms) / 60_000
  }

  /// Plays `pattern` on a Force Touch trackpad (nothing with a mouse, with
  /// haptics off in System Settings, or without a finger on the pad).
  static func play(_ pattern: Pattern, echoMs: Double = 0, onFrame: Bool) {
    guard let system = pattern.system else { return }
    let performer = NSHapticFeedbackManager.defaultPerformer
    let time: NSHapticFeedbackManager.PerformanceTime = onFrame ? .drawCompleted : .now
    performer.perform(system, performanceTime: time)
    guard echoMs > 0 else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + echoMs / 1000) {
      performer.perform(system, performanceTime: time)
    }
  }
}
