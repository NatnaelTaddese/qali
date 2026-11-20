import QaliDomain
import SwiftUI

/// Week start, clock format and working time zone (the first half of the
/// web's Preferences section).
struct DateTimePane: View {
  let data: CalendarData
  @State private var weekStart = 1
  /// "auto" | "12h" | "24h".
  @State private var timeFormat = "auto"
  @State private var error: String?
  @State private var showZones = false
  @State private var showAddZone = false
  /// The time rail's other zones, kept on this Mac.
  @AppStorage(ZoneRailPrefs.zones) private var railZones = ""

  private var stored: StoredPreferences? { data.preferences?.raw }

  var body: some View {
    Form {
      Section {
        Picker(selection: $weekStart) {
          Text("Monday").tag(1)
          Text("Sunday").tag(0)
          Text("Saturday").tag(6)
        } label: {
          Text("Week starts on")
          Text("First day of the calendar week")
        }

        Picker(selection: $timeFormat) {
          Text("Automatic").tag("auto")
          Divider()
          Text("12-hour (5:30 PM)").tag("12h")
          Text("24-hour (17:30)").tag("24h")
        } label: {
          Text("Time format")
          Text("Automatic follows the 12-hour clock")
        }
      }

      Section {
        LabeledContent {
          Button(zoneLabel) { showZones = true }
            .popover(isPresented: $showZones, arrowEdge: .bottom) {
              TimeZoneList(current: stored?.timeZone) { zone in
                showZones = false
                save("Couldn't save the time zone.", into: $error) {
                  try await data.updatePreferences(
                    zone.map { PreferencesPatch(timeZone: $0) } ?? PreferencesPatch(reset: [.timeZone])
                  )
                }
              }
            }
        } label: {
          Text("Time zone")
          Text("Your calendar and booking page run in this zone")
        }
      }

      Section {
        ForEach(railIdentifiers, id: \.self) { id in
          LabeledContent {
            Button {
              railZones = ZoneRailPrefs.encode(railIdentifiers.filter { $0 != id })
            } label: {
              Image(systemName: "minus.circle.fill")
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .help("Remove \(zoneShortLabel(id))")
            .accessibilityLabel("Remove \(zoneShortLabel(id))")
          } label: {
            Text(id.zoneLabel)
            Text(railDetail(id))
          }
        }
        if railIdentifiers.count < ZoneRailPrefs.limit {
          Button("Add Time Zone…") { showAddZone = true }
            .popover(isPresented: $showAddZone, arrowEdge: .bottom) {
              TimeZoneList(current: nil, includesAutomatic: false) { zone in
                showAddZone = false
                guard let zone, !railIdentifiers.contains(zone) else { return }
                railZones = ZoneRailPrefs.encode(railIdentifiers + [zone])
              }
            }
        }
      } header: {
        Text("Other time zones")
      } footer: {
        Text("Shown beside your hours in day and week view, up to two. Kept on this Mac.")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
    .saveErrors($error)
    .disabled(stored == nil)
    .onChange(of: stored, initial: true) { _, stored in
      weekStart = Int(stored?.weekStartsOn ?? 1)
      timeFormat = stored?.timeFormat ?? "auto"
    }
    .onChange(of: weekStart) { _, next in
      guard let stored, next != Int(stored.weekStartsOn ?? 1) else { return }
      save("Couldn't save the week start.", into: $error) {
        try await data.updatePreferences(PreferencesPatch(weekStartsOn: next))
      }
    }
    .onChange(of: timeFormat) { _, next in
      guard let stored, next != (stored.timeFormat ?? "auto") else { return }
      save("Couldn't save the time format.", into: $error) {
        try await data.updatePreferences(
          next == "auto" ? PreferencesPatch(reset: [.timeFormat]) : PreferencesPatch(timeFormat: next)
        )
      }
    }
  }

  private var railIdentifiers: [String] {
    Array(ZoneRailPrefs.identifiers(railZones).prefix(ZoneRailPrefs.limit))
  }

  /// "GMT+9 · 14 hours ahead" against the working zone.
  private func railDetail(_ id: String) -> String {
    guard let other = WorkingZone(identifier: id) else { return "Unknown zone" }
    let working = data.preferences?.zone ?? WorkingZone(.current)
    let gmt = other.timeZone.offsetLabel
    let seconds = other.timeZone.secondsFromGMT() - working.timeZone.secondsFromGMT()
    let code = zoneCode(id)
    if seconds == 0 { return "\(code) · \(gmt) · same time as you" }
    let hours = Double(abs(seconds)) / 3600
    let amount = hours == hours.rounded() ? "\(Int(hours)) hour\(hours == 1 ? "" : "s")" : String(format: "%.1f hours", hours)
    return "\(code) · \(gmt) · \(amount) \(seconds > 0 ? "ahead" : "behind")"
  }

  private var zoneLabel: String {
    if let zone = stored?.timeZone { return zone.zoneLabel }
    return "Automatic · \(TimeZone.current.identifier.zoneLabel)"
  }
}

extension String {
  /// "America/New_York" → "America/New York".
  fileprivate var zoneLabel: String { replacingOccurrences(of: "_", with: " ") }
}

/// A searchable list of every time zone, Automatic first.
private struct TimeZoneList: View {
  let current: String?
  var includesAutomatic = true
  let pick: (String?) -> Void
  @State private var query = ""

  private static let zones = TimeZone.knownTimeZoneIdentifiers.sorted()

  private var matches: [String] {
    let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
    guard !needle.isEmpty else { return Self.zones }
    return Self.zones.filter { $0.zoneLabel.lowercased().contains(needle) }
  }

  var body: some View {
    VStack(spacing: 0) {
      TextField("Search time zones", text: $query)
        .textFieldStyle(.roundedBorder)
        .padding(10)
      Divider()
      ScrollViewReader { proxy in
        List {
          if includesAutomatic, query.isEmpty {
            row("Automatic · \(TimeZone.current.identifier.zoneLabel)", selected: current == nil) { pick(nil) }
          }
          ForEach(matches, id: \.self) { zone in
            row(zone.zoneLabel, offset: TimeZone(identifier: zone)?.offsetLabel, selected: zone == current) {
              pick(zone)
            }
            .id(zone)
          }
        }
        .listStyle(.plain)
        .onAppear { if let current { proxy.scrollTo(current, anchor: .center) } }
      }
    }
    .frame(width: 320, height: 380)
  }

  private func row(_ title: String, offset: String? = nil, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack {
        Image(systemName: "checkmark")
          .opacity(selected ? 1 : 0)
          .frame(width: 14)
        Text(title).lineLimit(1)
        Spacer()
        if let offset { Text(offset).foregroundStyle(.secondary).monospacedDigit() }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
  }
}

extension TimeZone {
  /// "GMT+3", "GMT−5:30".
  fileprivate var offsetLabel: String {
    let seconds = secondsFromGMT()
    let sign = seconds < 0 ? "−" : "+"
    let hours = abs(seconds) / 3600, minutes = abs(seconds) % 3600 / 60
    if seconds == 0 { return "GMT" }
    return minutes == 0 ? "GMT\(sign)\(hours)" : "GMT\(sign)\(hours):\(String(format: "%02d", minutes))"
  }
}
