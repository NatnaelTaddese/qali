import AppKit
import QaliDomain
import SwiftUI

/// The travel offer's settings, kept per Mac.
enum TravelPrefs {
  /// Whether a change of this Mac's time zone offers to move the calendar.
  /// On unless turned off in Settings › Date & Time.
  static let offer = "travel.offer"
  /// The last Mac zone the user chose to keep their calendar out of, so it
  /// isn't offered again until the Mac moves somewhere else.
  static let dismissedZone = "travel.dismissedZone"
}

/// This Mac's time zone, kept current when the system's changes: after a
/// flight, or a change in System Settings.
@Observable
final class DeviceZone {
  private(set) var identifier: String
  @ObservationIgnored private var observer: NSObjectProtocol?

  init() {
    identifier = Self.current()
    observer = NotificationCenter.default.addObserver(
      forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.identifier = Self.current() }
    }
  }

  isolated deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  private static func current() -> String {
    #if DEBUG
      // `-QaliDeviceZone Asia/Tokyo` pretends the Mac is there, for captures.
      if let pinned = UserDefaults.standard.string(forKey: "QaliDeviceZone") { return pinned }
    #endif
    // The system zone is cached per process until reset.
    NSTimeZone.resetSystemTimeZone()
    return TimeZone.current.identifier
  }
}

/// Above the island when this Mac is in another time zone than the one the
/// calendar is pinned to: "This Mac is on Tokyo time", with Switch (the
/// calendar moves to Tokyo and the old zone joins the time rail) or Keep
/// (not asked again for this zone).
struct TravelOffer: View {
  let data: CalendarData

  @State private var device = DeviceZone()
  @State private var switching = false
  @AppStorage(TravelPrefs.offer) private var enabled = true
  @AppStorage(TravelPrefs.dismissedZone) private var dismissed = ""
  @AppStorage(ZoneRailPrefs.zones) private var railZones = ""

  /// The zone the calendar is pinned to; nil on Automatic.
  private var working: String? {
    #if DEBUG
      // `-QaliPinnedZone America/New_York` pretends the calendar is pinned
      // there, for captures (a Switch still saves for real).
      if let pinned = UserDefaults.standard.string(forKey: "QaliPinnedZone") { return pinned }
    #endif
    return data.preferences?.raw.timeZone
  }

  var body: some View {
    if enabled, let working,
      let zone = travelOffer(device: device.identifier, working: working, dismissed: dismissed.isEmpty ? nil : dismissed, at: .now)
    {
      card(to: zone, from: working)
        .transition(.opacity.combined(with: .offset(y: 6)))
    }
  }

  private func card(to zone: String, from working: String) -> some View {
    let city = zoneShortLabel(zone), home = zoneShortLabel(working)
    return HStack(spacing: 12) {
      Image(systemName: "airplane")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Palette.foreground)
        .frame(width: 30, height: 30)
        .background(Circle().fill(Palette.foreground.opacity(0.08)))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text("This Mac is on \(city) time")
          .font(.sans(TextSize.sm, .semibold))
          .foregroundStyle(Palette.foreground)
        Text("Show your calendar in \(city) time? \(home) moves beside your hours.")
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      Button("Keep \(home)") { dismissed = zone }
        .buttonStyle(.glass)
      Button("Switch") { move(to: zone, from: working) }
        .buttonStyle(.glassProminent)
        .disabled(switching)
    }
    .font(.sans(TextSize.xs, .medium))
    .padding(.leading, 12)
    .padding(.trailing, 10)
    .padding(.vertical, 10)
    .frame(width: 480)
    .glassEffect(.regular, in: .rect(cornerRadius: 20, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("This Mac is on \(city) time")
  }

  /// One preferences change: the Mac's zone becomes the working zone, and the
  /// old one takes its rail slot (or joins the rail). The card goes once the
  /// account answers, with the working zone and the rail changing together.
  private func move(to zone: String, from working: String) {
    let rail = zonesAfterTravelling(
      ZoneRailPrefs.identifiers(railZones), to: zone, from: working, limit: ZoneRailPrefs.limit
    )
    switching = true
    Task {
      do {
        try await data.updatePreferences(PreferencesPatch(timeZone: zone, otherTimeZones: rail))
      } catch {
        data.announce("Couldn't switch your time zone.")
      }
      switching = false
    }
  }
}
