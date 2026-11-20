import QaliDomain
import SwiftUI

/// The other time zones shown in the time rail. The account's preferences
/// hold them (`otherTimeZones`); `sync` mirrors them into UserDefaults, where
/// the views read them with `@AppStorage(ZoneRailPrefs.zones)` and
/// `ZoneRailPrefs.zones(_:)`.
enum ZoneRailPrefs {
  /// IANA identifiers, comma-separated, in rail order (left to right).
  static let zones = "zoneRail.zones"
  /// How many fit beside the working zone's hours.
  static let limit = 2

  static func zones(_ raw: String) -> [WorkingZone] {
    Array(identifiers(raw).compactMap(WorkingZone.init(identifier:)).prefix(limit))
  }

  static func identifiers(_ raw: String) -> [String] {
    raw.split(separator: ",").map(String.init).filter { !$0.isEmpty }
  }

  static func encode(_ identifiers: [String]) -> String {
    identifiers.joined(separator: ",")
  }

  /// Mirrors the account's zones into UserDefaults, from the cached row at
  /// launch and the live one after. An account that has never set any (by
  /// the live row: a cached one may predate the field) takes the zones this
  /// Mac kept on its own before they synced.
  @MainActor static func sync(_ stored: StoredPreferences, data: CalendarData, live: Bool) {
    let defaults = UserDefaults.standard
    let local = identifiers(defaults.string(forKey: zones) ?? "")
    guard let account = stored.otherTimeZones else {
      guard live, !local.isEmpty else { return }
      let upload = Array(local.prefix(limit))
      Task { try? await data.updatePreferences(PreferencesPatch(otherTimeZones: upload)) }
      return
    }
    let mirrored = Array(account.prefix(limit))
    if mirrored != local { defaults.set(encode(mirrored), forKey: zones) }
  }
}

extension GridMetrics {
  /// The width of each other zone's column, left of the working zone's: the
  /// same as the working zone's own, so the labels sit evenly apart.
  static let zoneColumn: CGFloat = gutter

  /// The whole rail: the working zone's gutter plus a column per other zone.
  static func gutter(zones: Int) -> CGFloat {
    gutter + zoneColumn * CGFloat(zones)
  }
}

extension EnvironmentValues {
  /// The time rail's width as laid out, other zones included.
  @Entry var railWidth: CGFloat = GridMetrics.gutter
}

/// The rail's corner of the date row: each zone's three-letter code and how
/// far it runs from the working zone, which sits on the right, next to the
/// days, its code as bright as the day numbers. Empty when no other zones are set.
struct ZoneRailHeader: View {
  let zone: WorkingZone

  @AppStorage(ZoneRailPrefs.zones) private var raw = ""

  var body: some View {
    let others = ZoneRailPrefs.zones(raw)
    HStack(spacing: 0) {
      if !others.isEmpty {
        ForEach(others, id: \.identifier) { other in
          cell(
            other.identifier,
            detail: zoneOffsetLabel(other, from: zone, at: .now),
            primary: false
          )
          .frame(width: GridMetrics.zoneColumn)
        }
        cell(zone.identifier, detail: gmtLabel(zone), primary: true)
          .frame(width: GridMetrics.gutter)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .allowsHitTesting(false)
  }

  private func cell(_ identifier: String, detail: String, primary: Bool) -> some View {
    let city = zoneShortLabel(identifier)
    return VStack(alignment: .trailing, spacing: 2) {
      Text(zoneCode(identifier))
        .font(.sans(10, .semibold))
        .tracking(0.4)
        .foregroundStyle(primary ? Palette.foreground : Palette.mutedForeground)
      Text(detail)
        .font(.sans(9))
        .monospacedDigit()
        .foregroundStyle(Palette.mutedForeground)
    }
    .padding(.trailing, 6)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
    .help(primary ? "\(city) (your calendar’s zone)" : "\(city), \(detail) from your zone")
    .accessibilityElement(children: .combine)
  }

  /// "GMT−5", "GMT+5:30", "GMT".
  private func gmtLabel(_ zone: WorkingZone) -> String {
    let seconds = zone.timeZone.secondsFromGMT(for: .now)
    if seconds == 0 { return "GMT" }
    let sign = seconds < 0 ? "−" : "+"
    let hours = abs(seconds) / 3600, minutes = abs(seconds) % 3600 / 60
    return minutes == 0 ? "GMT\(sign)\(hours)" : "GMT\(sign)\(hours):\(String(format: "%02d", minutes))"
  }
}

/// The other zones' columns in the hour body: their labels on the working
/// zone's hour lines, where their days, mornings and evenings start and
/// their current time. They stay put while the days scroll, like the gutter.
struct ZoneRailColumns: View {
  let hour: CGFloat
  /// The page's first day; the labels read its hours.
  let day: Date
  let navigation: CalendarNavigation

  @AppStorage(ZoneRailPrefs.zones) private var raw = ""

  var body: some View {
    let others = ZoneRailPrefs.zones(raw)
    if !others.isEmpty {
      HStack(spacing: 0) {
        ForEach(others, id: \.identifier) { other in
          ZoneColumn(
            other: other,
            column: zoneRailColumn(day: day, primary: navigation.zone, other: other, use24h: navigation.use24h),
            hour: hour,
            navigation: navigation
          )
          .frame(width: GridMetrics.zoneColumn)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
  }
}

private struct ZoneColumn: View {
  let other: WorkingZone
  let column: ZoneRailColumn
  let hour: CGFloat
  let navigation: CalendarNavigation

  var body: some View {
    TimelineView(.everyMinute) { timeline in
      let nowY = timeline.date.timeIntervalSince(navigation.zone.startOfDay(timeline.date)) / 3600 * hour
      content(now: timeline.date, nowY: nowY)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private func content(now: Date, nowY: CGFloat) -> some View {
    ZStack(alignment: .topLeading) {
      ForEach(column.dayStarts, id: \.hours) { start in
        Path { path in
          let y = (start.hours * hour).rounded() + 0.5
          path.move(to: CGPoint(x: 10, y: y))
          // Into the label's right edge, so it reads as a tick under it.
          path.addLine(to: CGPoint(x: GridMetrics.zoneColumn - 6, y: y))
        }
        .stroke(Palette.mutedForeground.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
      }

      // Labels the current time would sit on give way to it, as the
      // working zone's do under its pill.
      ForEach(column.labels.filter { abs(CGFloat($0.line) * hour - nowY) >= 14 }, id: \.line) { label in
        let startsDay = column.dayStarts.contains { $0.hours == Double(label.line) }
        Text(label.text)
          .font(.sans(10, startsDay ? .semibold : .regular))
          .monospacedDigit()
          .foregroundStyle(startsDay ? Palette.foreground : Palette.mutedForeground)
          .padding(.leading, 2)
          .background(Palette.background)
          .frame(width: GridMetrics.zoneColumn - 6, height: 16, alignment: .trailing)
          .offset(y: CGFloat(label.line) * hour - 8)
      }

      // Where the zone's morning (sun, 6am) and evening (moon, 6pm) start,
      // at the column's leading edge, clear of the right-aligned labels.
      ForEach(column.daylightEdges, id: \.hours) { edge in
        Image(systemName: edge.rises ? "sun.max.fill" : "moon.fill")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(edge.rises ? Palette.event(3) : Palette.mutedForeground)
          .frame(width: 12, height: 12)
          .offset(x: 4, y: edge.hours * hour - 6)
      }

      // Which way the new day runs, beside the line where it starts.
      ForEach(column.dayStarts.filter { $0.dayOffset != 0 }, id: \.hours) { start in
        Text(start.dayOffset > 0 ? "+\(start.dayOffset)" : "−\(-start.dayOffset)")
          .font(.sans(8, .semibold))
          .foregroundStyle(Palette.foreground)
          .padding(.horizontal, 2.5)
          .background(RoundedRectangle(cornerRadius: 3).fill(Palette.muted))
          .frame(height: 12)
          .offset(x: 1, y: start.hours * hour - 6)
      }

      Text(other.format(now, timePattern(use24h: navigation.use24h, withDayPeriod: false)))
        .font(.sans(10, .semibold))
        .monospacedDigit()
        .foregroundStyle(Palette.now)
        .frame(width: GridMetrics.zoneColumn - 6, height: 14, alignment: .trailing)
        .offset(y: nowY - 7)
    }
  }
}

/// A line on the trailing edge of each other zone's column, in the day
/// dividers' colour: between the zone columns and before the working zone's.
struct ZoneDividers: View {
  @AppStorage(ZoneRailPrefs.zones) private var raw = ""

  var body: some View {
    let count = ZoneRailPrefs.zones(raw).count
    Canvas { context, size in
      var path = Path()
      for index in 0..<count {
        let x = (CGFloat(index + 1) * GridMetrics.zoneColumn).rounded() - 0.5
        path.move(to: CGPoint(x: x, y: 0))
        path.addLine(to: CGPoint(x: x, y: size.height))
      }
      context.stroke(path, with: .color(Palette.border), lineWidth: 1)
    }
  }
}
