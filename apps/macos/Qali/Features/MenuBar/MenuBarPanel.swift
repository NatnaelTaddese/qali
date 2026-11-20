import QaliDomain
import SwiftUI

/// What the panel's buttons do; the controller fills these in.
struct MenuBarActions {
  var openApp: () -> Void
  var openSettings: () -> Void
  var quit: () -> Void
}

/// The glass panel under the status item. It sits in the system's menu
/// frame (Liquid Glass, dividers, full-width hover rows) but speaks qali:
/// a Fraunces weekday, Lexend text, the calendar's time column and colour
/// rails, the red now line, tinted all-day chips.
struct MenuBarPanel: View {
  /// The glass's corner radius; the window (MenuBarController) draws the
  /// glass, its edge and its shadow natively.
  static let cornerRadius: CGFloat = 22

  let actions: MenuBarActions
  @Environment(AppModel.self) private var model
  @AppStorage(MenuBarPrefs.includeTomorrow) private var includeTomorrow = true
  @AppStorage(MenuBarPrefs.worldClock) private var showsWorldClock = true
  @AppStorage(ZoneRailPrefs.zones) private var railZones = ""

  var body: some View {
    TimelineView(.periodic(from: .now, by: 30)) { context in
      let now = companionNow(context.date)
      VStack(alignment: .leading, spacing: 0) {
        if let data = model.calendarData {
          agenda(data, now: now)
            .agendaWindow(data, now: now)
        } else {
          Header(title: "qali", detail: "Sign in to see your day here.")
        }
        PanelDivider()
        footer
      }
    }
    .padding(.vertical, 10)
    .padding(.horizontal, 6)
    .frame(width: 320)
    .fixedSize()
  }

  @ViewBuilder
  private func agenda(_ data: CalendarData, now: Date) -> some View {
    let prefs = data.preferences
    let zone = prefs?.zone ?? WorkingZone(.current)
    let use24h = prefs?.use24h ?? false
    let today = zone.startOfDay(now)

    if let events = data.agendaEvents {
      let day = agendaDay(events, dayStart: today, zone: zone)
      let left = day.timed.filter { $0.endMs > now.ms }.count
      Header(
        title: zone.format(now, "EEEE"),
        detail: left == 0 ? zone.format(now, "d MMM") : "\(zone.format(now, "d MMM")) · \(left) to go"
      )
      worldClock(now: now, zone: zone, use24h: use24h)
      if !day.allDay.isEmpty {
        AllDayChips(events: day.allDay, data: data)
          .padding(.horizontal, 10)
          .padding(.bottom, 8)
      }
      DayList(data: data, timed: day.timed, now: now, zone: zone, use24h: use24h, isToday: true, open: actions.openApp)

      if includeTomorrow {
        let tomorrow = agendaDay(events, dayStart: zone.addingDays(1, to: today), zone: zone)
        if !tomorrow.allDay.isEmpty || !tomorrow.timed.isEmpty {
          PanelDivider()
          SectionTitle("Tomorrow")
          if !tomorrow.allDay.isEmpty {
            AllDayChips(events: tomorrow.allDay, data: data)
              .padding(.horizontal, 10)
              .padding(.bottom, tomorrow.timed.isEmpty ? 2 : 6)
          }
          DayList(data: data, timed: tomorrow.timed, now: now, zone: zone, use24h: use24h, isToday: false, open: actions.openApp)
        }
      }
    } else {
      Header(title: zone.format(now, "EEEE"), detail: zone.format(now, "d MMM"))
      worldClock(now: now, zone: zone, use24h: use24h)
      ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 60)
    }
  }

  /// Your zone's clock and each time-rail zone's, when there are any.
  @ViewBuilder
  private func worldClock(now: Date, zone: WorkingZone, use24h: Bool) -> some View {
    let others = ZoneRailPrefs.zones(railZones)
    if showsWorldClock, !others.isEmpty {
      WorldClockRow(entries: QaliDomain.worldClock(now: now, others: others, primary: zone, use24h: use24h))
    }
  }

  /// Laid out like a system menu: title on the left, shortcut on the right.
  private var footer: some View {
    VStack(alignment: .leading, spacing: 0) {
      MenuRow("Open qali", shortcut: "⌘1", action: actions.openApp)
      MenuRow("Settings…", shortcut: "⌘,", action: actions.openSettings)
      PanelDivider()
      MenuRow("Quit qali Completely", shortcut: "⌘Q", action: actions.quit)
    }
  }
}

/// A tile per zone: day or night there, its code, its time, and its day and
/// offset from yours. Yours comes first, a shade stronger.
private struct WorldClockRow: View {
  let entries: [WorldClockEntry]

  var body: some View {
    HStack(spacing: 6) {
      ForEach(entries, id: \.identifier) { entry in
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 4) {
            Image(systemName: entry.isDaytime ? "sun.max.fill" : "moon.fill")
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(entry.isDaytime ? AnyShapeStyle(Palette.event(3)) : AnyShapeStyle(.secondary))
            Text(entry.code)
              .font(.sans(TextSize.xs, .semibold))
              .tracking(0.4)
              .foregroundStyle(entry.isWorkingZone ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
          }
          Text(entry.time)
            .font(.sans(15, .semibold))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.8)
          Text(entry.offset.map { "\(entry.day) · \($0)" } ?? entry.day)
            .font(.sans(TextSize.xs))
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(entry.isWorkingZone ? 0.08 : 0.04), in: .rect(cornerRadius: 10))
        .help(zoneShortLabel(entry.identifier))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
          "\(zoneShortLabel(entry.identifier)): \(entry.time), \(entry.day)\(entry.isDaytime ? "" : ", night")"
        )
      }
    }
    .padding(.horizontal, 10)
    .padding(.bottom, 10)
  }
}

private struct Header: View {
  let title: String
  let detail: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(title)
        .font(.display(22))
      Text(detail)
        .font(.sans(TextSize.sm))
        .foregroundStyle(.secondary)
        .lineLimit(1)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .padding(.bottom, 10)
  }
}

/// A day's timed events. Today keeps the finished ones (dimmed) and draws
/// the now line before the first event still to start.
private struct DayList: View {
  let data: CalendarData
  let timed: [CalendarEvent]
  let now: Date
  let zone: WorkingZone
  let use24h: Bool
  let isToday: Bool
  let open: () -> Void

  var body: some View {
    let nowIndex = isToday ? timed.firstIndex { $0.startMs > now.ms } ?? timed.count : nil
    ForEach(Array(timed.enumerated()), id: \.element.id) { index, event in
      if index == nowIndex, index > 0 { NowLine(now: now, zone: zone, use24h: use24h) }
      EventRow(
        data: data, event: event, now: now, zone: zone, use24h: use24h,
        isToday: isToday, past: isToday && event.endMs <= now.ms, open: open
      )
    }
    if isToday, nowIndex == timed.count {
      if !timed.isEmpty { NowLine(now: now, zone: zone, use24h: use24h) }
      Text(timed.isEmpty ? "Nothing on today" : "Nothing else today")
        .font(.sans(TextSize.sm))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }
  }
}

private struct EventRow: View {
  let data: CalendarData
  let event: CalendarEvent
  let now: Date
  let zone: WorkingZone
  let use24h: Bool
  let isToday: Bool
  let past: Bool
  let open: () -> Void
  @Environment(\.openURL) private var openURL

  private var call: URL? { event.conferenceUrl.flatMap(URL.init(string:)) }
  private var isOn: Bool { isToday && event.startMs <= now.ms && event.endMs > now.ms }

  var body: some View {
    let pattern = timePattern(use24h: use24h, withDayPeriod: false)
    HoverRow(action: open) {
      VStack(alignment: .trailing, spacing: 0) {
        Text(zone.format(Date(ms: event.startMs), pattern))
        Text(zone.format(Date(ms: event.endMs), pattern))
          .foregroundStyle(.secondary)
      }
      .font(.sans(TextSize.xs))
      .monospacedDigit()
      .frame(width: 38, alignment: .trailing)

      RoundedRectangle(cornerRadius: 1.5)
        .fill(Palette.event(data.colorKey(for: event)))
        .frame(width: 3, height: 30)

      VStack(alignment: .leading, spacing: 1) {
        Text(event.summary ?? "(No title)")
          .font(.sans(TextSize.sm, .medium))
        if let detail {
          Text(detail)
            .font(.sans(TextSize.xs))
            .foregroundStyle(isOn ? AnyShapeStyle(Palette.now) : AnyShapeStyle(.secondary))
        }
      }
      .lineLimit(1)

      Spacer(minLength: 4)

      if isToday, !past, let call, event.startMs - now.ms < 15 * msPerMinute {
        Button { openURL(call) } label: {
          Text("Join")
            .font(.sans(TextSize.xs, .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .frame(height: 24)
            .background(Palette.meet, in: .capsule)
        }
        .buttonStyle(.plain)
        .help("Join the call")
      } else if call != nil, !past {
        Image(systemName: "video.fill")
          .font(.system(size: 11))
          .foregroundStyle(.secondary)
      }
    }
    .opacity(past ? 0.45 : 1)
  }

  private var detail: String? {
    let nowMs = now.ms
    if isOn { return "Now · ends in \(countdownText(to: event.endMs, now: now))" }
    if isToday, event.startMs > nowMs, event.startMs - nowMs < 3 * msPerHour {
      return "In \(countdownText(to: event.startMs, now: now))"
    }
    if let location = event.location, !location.isEmpty { return location }
    return nil
  }
}

private struct NowLine: View {
  let now: Date
  let zone: WorkingZone
  let use24h: Bool

  var body: some View {
    HStack(spacing: 8) {
      Text(zone.format(now, timePattern(use24h: use24h, withDayPeriod: false)))
        .font(.sans(10, .semibold))
        .monospacedDigit()
        .foregroundStyle(.white)
        .padding(.horizontal, 4)
        .background(Palette.now, in: .rect(cornerRadius: 4))
        .frame(width: 38, alignment: .trailing)
      Rectangle().fill(Palette.now).frame(height: 1.5)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 2)
    .accessibilityHidden(true)
  }
}

/// All-day events as tinted chips that wrap onto as many lines as needed.
private struct AllDayChips: View {
  let events: [CalendarEvent]
  let data: CalendarData

  var body: some View {
    WrapLayout(spacing: 6) {
      ForEach(events) { event in
        let color = Palette.event(data.colorKey(for: event))
        HStack(spacing: 6) {
          Circle().fill(color).frame(width: 6, height: 6)
          Text(event.summary ?? "(No title)")
            .font(.sans(TextSize.xs, .medium))
            .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .frame(height: 22)
        .background(color.opacity(0.16), in: .rect(cornerRadius: 7, style: .continuous))
      }
    }
  }
}

/// Places children left to right and starts a new line when one won't fit.
private struct WrapLayout: Layout {
  var spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > 0, x + size.width > width {
        y += line + spacing
        x = 0
        line = 0
      }
      x += size.width + spacing
      line = max(line, size.height)
      widest = max(widest, x - spacing)
    }
    return CGSize(width: min(widest, width), height: y + line)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > bounds.minX, x + size.width > bounds.maxX {
        y += line + spacing
        x = bounds.minX
        line = 0
      }
      view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      line = max(line, size.height)
    }
  }
}

/// A full-width row with the system menus' rounded hover highlight.
private struct HoverRow<Content: View>: View {
  let action: () -> Void
  @ViewBuilder let content: Content
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 8) { content }
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(.primary.opacity(hovering ? 0.08 : 0))
      }
      .contentShape(.rect)
      .onHover { hovering = $0 }
      .onTapGesture(perform: action)
  }
}

private struct SectionTitle: View {
  let title: String
  init(_ title: String) { self.title = title }

  var body: some View {
    Text(title)
      .font(.sans(TextSize.xs, .medium))
      .foregroundStyle(.secondary)
      .padding(.horizontal, 10)
      .padding(.bottom, 6)
  }
}

private struct PanelDivider: View {
  var body: some View {
    Rectangle()
      .fill(.primary.opacity(0.1))
      .frame(height: 1)
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
  }
}

/// A menu item: title, right-aligned shortcut, the shared hover highlight.
private struct MenuRow: View {
  let title: String
  let shortcut: String
  let action: () -> Void

  init(_ title: String, shortcut: String, action: @escaping () -> Void) {
    self.title = title
    self.shortcut = shortcut
    self.action = action
  }

  var body: some View {
    HoverRow(action: action) {
      Text(title)
        .font(.sans(TextSize.sm))
      Spacer(minLength: 12)
      Text(shortcut)
        .font(.system(size: 13))
        .foregroundStyle(.tertiary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isButton)
  }
}
