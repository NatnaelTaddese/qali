import QaliDomain
import SwiftUI

/// The island's search face (the web's `SearchPanel`): a title search over
/// the selected calendars. The result list grows the card as matches arrive,
/// and picking one takes the calendar to that day.
struct SearchPanel: View {
  let island: Island
  let data: CalendarData
  let navigation: CalendarNavigation

  @State private var text = ""
  /// What has been sent to the server: the text, trimmed, once typing pauses.
  @State private var query = ""
  @State private var active = 0
  @State private var results: LiveQuery<[CalendarEvent]>
  @FocusState private var focused: Bool

  /// The web's `SEARCH_QUERY_MAX_LENGTH`.
  private static let maxLength = 120
  private static let rowHeight: CGFloat = 46

  init(island: Island, data: CalendarData, navigation: CalendarNavigation) {
    self.island = island
    self.data = data
    self.navigation = navigation
    _results = State(initialValue: LiveQuery(data.client, ConvexAPI.searchEvents, args: nil))
  }

  /// The matches for the current query; nil before anything has been searched.
  private var matches: [CalendarEvent]? {
    query.isEmpty ? nil : results.value
  }

  private var loading: Bool { !query.isEmpty && results.isLoading }

  var body: some View {
    let matches = matches
    let count = matches?.count ?? 0
    let activeIndex = min(active, max(count - 1, 0))
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(Palette.mutedForeground)
        TextField("Search events", text: $text)
          .textFieldStyle(.plain)
          .font(.sans(TextSize.base, .semibold))
          .focused($focused)
          .onSubmit {
            if !loading, let matches, matches.indices.contains(activeIndex) { pick(matches[activeIndex]) }
          }
          .onKeyPress(.downArrow) {
            active = count == 0 ? 0 : (activeIndex + 1) % count
            return .handled
          }
          .onKeyPress(.upArrow) {
            active = count == 0 ? 0 : (activeIndex - 1 + count) % count
            return .handled
          }
        if loading {
          ProgressView().controlSize(.small)
        }
        IslandCloseButton(action: island.close)
      }

      if let matches, !matches.isEmpty {
        ScrollViewReader { scroll in
          ScrollView {
            VStack(spacing: 0) {
              ForEach(Array(matches.enumerated()), id: \.element.id) { index, event in
                SearchRow(
                  event: event,
                  hue: Palette.event(data.colorKey(for: event)),
                  detail: detail(event),
                  active: index == activeIndex
                ) {
                  pick(event)
                }
                .frame(height: Self.rowHeight)
                .id(event.id)
                .onHover { if $0 { active = index } }
              }
            }
          }
          // Seven rows before the list scrolls.
          .frame(height: CGFloat(min(count, 7)) * Self.rowHeight)
          .padding(.horizontal, -8)
          .opacity(loading ? 0.6 : 1)
          .onChange(of: activeIndex) { _, index in
            if matches.indices.contains(index) { scroll.scrollTo(matches[index].id) }
          }
        }
      } else {
        Text(matches != nil && !loading ? "No events match “\(query)”" : "Find an event by its title")
          .font(.sans(TextSize.sm))
          .foregroundStyle(Palette.mutedForeground)
          .padding(.horizontal, 2)
      }
    }
    .foregroundStyle(Palette.foreground)
    .onAppear { focused = true }
    .onChange(of: text) { _, next in
      if next.count > Self.maxLength { text = String(next.prefix(Self.maxLength)) }
      active = 0
    }
    // Typing pauses for a moment before the query goes to the server, so a
    // burst of keystrokes is one subscription.
    .task(id: text) {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty {
        query = ""
        results.setArgs(nil)
        return
      }
      try? await Task.sleep(for: .milliseconds(120))
      guard !Task.isCancelled else { return }
      query = trimmed
      // The upcoming/past split is anchored to the minute, so one client's
      // subscriptions share the server's cache within it.
      let minute = (Date.now.ms / 60_000).rounded(.down) * 60_000
      results.setArgs(["query": trimmed, "nowMs": minute])
    }
  }

  /// Takes the calendar to the event's day and hands the island to it.
  private func pick(_ event: CalendarEvent) {
    let day =
      event.allDay
      ? Date(ms: fromUtcMidnight(event.startMs, zone: navigation.zone))
      : Date(ms: event.startMs)
    navigation.jump(to: day)
    island.open(.event(event))
  }

  /// One line of when and where: "Tomorrow · 9:00 – 9:30 AM · Work".
  private func detail(_ event: CalendarEvent) -> String {
    let zone = navigation.zone
    let when: String
    switch eventTimeParts(event, use24h: navigation.use24h, zone: zone) {
    case .allDay(let start, let lastDay):
      when =
        zone.isSameDay(start, lastDay)
        ? "\(dayLabel(start)) · All day"
        : "\(dayLabel(start)) – \(dayLabel(lastDay))"
    case .timed(let start, _, let pattern, let endText):
      when = "\(dayLabel(start)) · \(zone.format(start, pattern)) – \(endText)"
    }
    guard let calendar = data.calendar(id: event.localCalendarId) else { return when }
    return "\(when) · \(calendar.displayName)"
  }

  private func dayLabel(_ date: Date) -> String {
    let zone = navigation.zone
    let now = Date.now
    if zone.isSameDay(date, now) { return "Today" }
    if zone.isSameDay(date, zone.addingDays(1, to: now)) { return "Tomorrow" }
    if zone.isSameDay(date, zone.addingDays(-1, to: now)) { return "Yesterday" }
    return zone.format(date, zone.isSameYear(date, now) ? "EEE d MMM" : "EEE d MMM yyyy")
  }
}

private struct SearchRow: View {
  let event: CalendarEvent
  let hue: Color
  let detail: String
  let active: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        Capsule()
          .fill(hue)
          .frame(width: 3, height: 30)
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 6) {
            Text(event.title)
              .font(.sans(TextSize.sm, .medium))
            if event.providerSeriesId != nil {
              Image(systemName: "repeat")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Palette.mutedForeground)
                .accessibilityLabel("Repeats")
            }
          }
          Text(detail)
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
        }
        .lineLimit(1)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 10)
      .frame(maxHeight: .infinity)
      .background(Palette.foreground.opacity(active ? 0.08 : 0), in: .rect(cornerRadius: 12, style: .continuous))
      .padding(.horizontal, 8)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(active ? .isSelected : [])
  }
}
