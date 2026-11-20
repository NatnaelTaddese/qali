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
  let data: CalendarData

  @AppStorage(ZoneRailPrefs.zones) private var raw = ""

  var body: some View {
    let others = ZoneRailPrefs.zones(raw)
    HStack(spacing: 0) {
      if !others.isEmpty {
        let ids = others.map(\.identifier)
        ForEach(Array(others.enumerated()), id: \.element.identifier) { index, other in
          let city = zoneShortLabel(other.identifier)
          Menu {
            Section("\(city) · \(other.format(.now, timePattern(use24h: data.preferences?.use24h ?? false))) · \(zoneOffsetPhrase(other, from: zone, at: .now))") {
              Button("Make \(city) Your Time Zone") {
                ZoneRailEdits.makePrimary(other.identifier, rail: ids, working: zone, data: data)
              }
            }
            Section {
              Button("Move Left") { ZoneRailEdits.save(zonesMoving(ids, other.identifier, by: -1), data: data) }
                .disabled(index == 0)
              Button("Move Right") { ZoneRailEdits.save(zonesMoving(ids, other.identifier, by: 1), data: data) }
                .disabled(index == ids.count - 1)
            }
            Section {
              Button("Time Zone Settings…") { ZoneRailEdits.openSettings() }
              Button("Remove \(city)") {
                ZoneRailEdits.save(ids.filter { $0 != other.identifier }, data: data)
              }
            }
          } label: {
            ZoneRailCell(
              identifier: other.identifier,
              detail: zoneOffsetLabel(other, from: zone, at: .now),
              primary: false
            )
          }
          .zoneRailMenu()
          .frame(width: GridMetrics.zoneColumn)
        }
        Menu {
          Section("\(zoneShortLabel(zone.identifier)) · your time zone") {
            Button("Time Zone Settings…") { ZoneRailEdits.openSettings() }
          }
        } label: {
          ZoneRailCell(identifier: zone.identifier, detail: gmtLabel(zone), primary: true)
        }
        .zoneRailMenu()
        .frame(width: GridMetrics.gutter)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
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

/// One zone's code and offset in the rail's header, lit while the pointer
/// is over it to say it opens a menu.
private struct ZoneRailCell: View {
  let identifier: String
  let detail: String
  let primary: Bool

  @State private var hovering = false

  var body: some View {
    let city = zoneShortLabel(identifier)
    VStack(alignment: .trailing, spacing: 2) {
      Text(zoneCode(identifier))
        .font(.sans(10, .semibold))
        .tracking(0.4)
        .foregroundStyle(primary || hovering ? Palette.foreground : Palette.mutedForeground)
      Text(detail)
        .font(.sans(9))
        .monospacedDigit()
        .foregroundStyle(Palette.mutedForeground)
    }
    .padding(.trailing, 6)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
    .background {
      RoundedRectangle(cornerRadius: 6)
        .fill(Palette.foreground.opacity(hovering ? 0.07 : 0))
        .padding(.vertical, 6)
        .padding(.horizontal, 3)
    }
    .contentShape(.rect)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
    .help(primary ? "\(city), your time zone" : "\(city), \(detail) from your zone")
    .accessibilityElement(children: .combine)
    .accessibilityHint("Opens a menu")
  }
}

extension View {
  /// A rail header cell as a plain, indicator-less pull-down: the cell is the
  /// button and the menu is the system's.
  fileprivate func zoneRailMenu() -> some View {
    menuStyle(.button)
      .buttonStyle(.plain)
      .menuIndicator(.hidden)
  }
}

/// The rail header menus' changes: the zones are saved to the account, and
/// shown at once except for a swap with the working zone, which waits for
/// the account so the rail and the working zone change together.
@MainActor enum ZoneRailEdits {
  static func save(_ identifiers: [String], data: CalendarData) {
    let defaults = UserDefaults.standard
    let before = defaults.string(forKey: ZoneRailPrefs.zones)
    defaults.set(ZoneRailPrefs.encode(identifiers), forKey: ZoneRailPrefs.zones)
    Task {
      do {
        try await data.updatePreferences(PreferencesPatch(otherTimeZones: identifiers))
      } catch {
        defaults.set(before, forKey: ZoneRailPrefs.zones)
        data.announce("Couldn't save your time zones.")
      }
    }
  }

  static func makePrimary(_ identifier: String, rail: [String], working: WorkingZone, data: CalendarData) {
    let next = zonesAfterMakingPrimary(rail, other: identifier, working: working.identifier)
    Task {
      do {
        try await data.updatePreferences(PreferencesPatch(timeZone: identifier, otherTimeZones: next))
      } catch {
        data.announce("Couldn't change your time zone.")
      }
    }
  }

  static func openSettings() {
    (NSApp.delegate as? AppDelegate)?.showSettings(pane: .dateTime)
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
