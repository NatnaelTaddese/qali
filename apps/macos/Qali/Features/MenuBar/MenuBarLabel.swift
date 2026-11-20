import QaliDomain
import SwiftUI

/// What the status item draws, in the menu bar's own font. The Settings pane
/// draws the same view as its preview.
struct MenuBarLabel: View {
  @Environment(AppModel.self) private var model
  @AppStorage(MenuBarPrefs.style) private var styleRaw = MenuBarStyle.nextUp.rawValue
  @AppStorage(MenuBarPrefs.showTitles) private var showTitles = true
  @AppStorage(MenuBarPrefs.lookahead) private var lookahead = 180
  @AppStorage(MenuBarPrefs.joinPill) private var joinPill = true

  var body: some View {
    TimelineView(.periodic(from: .now, by: 15)) { context in
      content(now: companionNow(context.date))
        .agendaWindow(model.calendarData, now: companionNow(context.date))
    }
    .font(.system(size: 13))
    .lineLimit(1)
    .fixedSize()
    .padding(.horizontal, 4)
  }

  @ViewBuilder
  private func content(now: Date) -> some View {
    let data = model.calendarData
    let zone = data?.preferences?.zone ?? WorkingZone(.current)
    let style = MenuBarStyle(rawValue: styleRaw) ?? .nextUp
    let next = style == .nextUp
      ? data?.agendaEvents.flatMap { nextUpEvent($0, now: now, lookahead: lookahead, zone: zone) }
      : nil

    if let data, let next {
      HStack(spacing: 5) {
        if joinPill && isJoinable(next, now: now) {
          Text("Join")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .frame(height: 16)
            .background(Palette.meet, in: .rect(cornerRadius: 4, style: .continuous))
        } else {
          Circle()
            .fill(Palette.event(data.colorKey(for: next)))
            .frame(width: 7, height: 7)
        }
        Text(text(for: next, now: now, joining: joinPill && isJoinable(next, now: now)))
      }
    } else if style == .icon {
      Image(systemName: "calendar")
    } else {
      // Just the day, in the app's serif.
      Text(zone.format(now, "d"))
        .font(.display(15, .bold))
        .accessibilityLabel(zone.format(now, "EEEE, MMMM d"))
    }
  }

  /// Short enough that macOS doesn't push the item into the menu bar's
  /// overflow on a crowded bar; the Join pill leaves room for less.
  private func text(for event: CalendarEvent, now: Date, joining: Bool) -> String {
    let countdown = countdownText(to: event.startMs, now: now)
    let when = countdown == "now" ? "now" : "in \(countdown)"
    guard showTitles else {
      if joining { return countdown == "now" ? "now" : when }
      return countdown == "now" ? "Event now" : "Event \(when)"
    }
    let limit = joining ? 12 : 20
    var title = (event.summary?.trimmingCharacters(in: .whitespaces)).flatMap { $0.isEmpty ? nil : $0 } ?? "(No title)"
    if title.count > limit { title = String(title.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…" }
    return joining ? title : "\(title) · \(countdown)"
  }
}

extension View {
  /// Keeps the agenda subscription on today and tomorrow in the working
  /// zone, moving it at midnight and when the data model changes.
  func agendaWindow(_ data: CalendarData?, now: Date) -> some View {
    let zone = data?.preferences?.zone ?? WorkingZone(.current)
    let start = zone.startOfDay(now)
    let key = "\(data.map { ObjectIdentifier($0).hashValue } ?? 0):\(start.ms)"
    return task(id: key) {
      data?.setAgendaWindow(startMs: start.ms, endMs: zone.addingDays(2, to: start).ms)
    }
  }
}
