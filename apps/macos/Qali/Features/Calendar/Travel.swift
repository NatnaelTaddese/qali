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
    // A pill like the island's own nav row: one line of each, sized to its
    // words, and the island's buttons (a soft pill, then the primary one).
    return HStack(spacing: 10) {
      Image(systemName: "airplane")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Palette.foreground)
        .frame(width: 30, height: 30)
        .background(Circle().fill(Palette.foreground.opacity(0.08)))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text("This Mac is on \(city) time")
          .font(.sans(TextSize.sm, .semibold))
          .foregroundStyle(Palette.foreground)
        Text("Switching moves \(home) beside your hours.")
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
      }
      .lineLimit(1)
      Spacer(minLength: 16)
      TravelSecondaryButton(title: "Keep \(home)") { dismissed = zone }
      Button {
        move(to: zone, from: working)
      } label: {
        HStack(spacing: 6) {
          if switching { ProgressView().controlSize(.mini) }
          Text("Switch to \(city)")
        }
        .font(.sans(TextSize.sm, .medium))
        .padding(.horizontal, 4)
      }
      .modifier(PrimaryButton())
      .disabled(switching)
    }
    .padding(.leading, 9)
    .padding(.trailing, 8)
    .padding(.vertical, 8)
    .fixedSize()
    .glassEffect(.regular, in: .capsule)
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

/// The offer's secondary button, as the island's Edit pill: a soft capsule
/// in the qali font, a shade stronger on hover.
private struct TravelSecondaryButton: View {
  let title: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.sans(TextSize.sm, .medium))
        .foregroundStyle(Palette.foreground)
        .padding(.horizontal, 12)
        .frame(height: 28)
        .background(Palette.foreground.opacity(hovering ? 0.14 : 0.08), in: .capsule)
        .contentShape(.capsule)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
  }
}
