import AppKit
import QaliDomain
import SwiftUI

/// The island's event face (the web's `EventDetail`): who, when and where at
/// a glance, the call to join, the guests and their answers, the
/// description, your own answer if you are invited, and the actions on it.
///
/// It reads the event from the live window, so an answer or a change made
/// elsewhere lands in the open panel. The description opens on a screen of
/// its own, as in the create form.
struct EventDetailPanel: View {
  /// The event as it was opened; `data.current` keeps it up to date.
  let event: CalendarEvent
  let island: Island
  let data: CalendarData
  let navigation: CalendarNavigation

  @State private var readingNotes = false
  @State private var mainHeight: CGFloat?
  /// A repeating event's rule lines; the inner nil is "not fetched yet".
  @State private var recurrence: LiveQuery<[String]?>
  @State private var recurrenceFailed = false
  /// The time rail's other zones, whose clocks the event is also read in.
  @AppStorage(ZoneRailPrefs.zones) private var railZones = ""

  init(event: CalendarEvent, island: Island, data: CalendarData, navigation: CalendarNavigation) {
    self.event = event
    self.island = island
    self.data = data
    self.navigation = navigation
    _recurrence = State(
      initialValue: LiveQuery(
        data.client,
        ConvexAPI.getEventRecurrence,
        args: event.providerSeriesId == nil ? nil : ["eventId": event.id]
      )
    )
  }

  private var live: CalendarEvent { data.current(event) }

  /// `-QaliDetail notes|guests` opens the description screen or the guest
  /// list, for captures.
  fileprivate static var debugScreen: String? {
    #if DEBUG
      UserDefaults.standard.string(forKey: "QaliDetail")
    #else
      nil
    #endif
  }

  var body: some View {
    let event = live
    ZStack(alignment: .topLeading) {
      if readingNotes {
        VStack(alignment: .leading, spacing: 10) {
          BackButton(title: event.title) { showNotes(false) }
          RichTextEditor(
            initial: DescriptionHTML.attributed(from: event.description ?? ""),
            controller: RichTextController(),
            editable: false
          ) { _ in }
          .frame(maxHeight: .infinity)
        }
        .frame(height: mainHeight ?? 240)
        .escapeGoesBack(island: island) { showNotes(false) }
        .transition(.drillDown(forward: true))
      } else {
        main(event)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { mainHeight = $0 }
          .transition(.drillDown(forward: false))
      }
    }
    .font(.sans(TextSize.sm))
    .foregroundStyle(Palette.foreground)
    .task {
      // From the main screen, as a press on the description would.
      if Self.debugScreen == "notes" {
        try? await Task.sleep(for: .milliseconds(600))
        showNotes(true)
      }
    }
    .task {
      // A rule that has not come in a few seconds is not worth a spinner.
      guard event.providerSeriesId != nil else { return }
      try? await Task.sleep(for: .seconds(5))
      if recurrence.value == nil || recurrence.value == .some(nil) { recurrenceFailed = true }
    }
    .task(id: recurrence.value.map { $0 == nil }) {
      // The server holds no rule for this series yet: ask it to fetch one.
      guard event.providerSeriesId != nil, case .some(.none) = recurrence.value else { return }
      do { try await data.refreshRecurrence(of: event) } catch { recurrenceFailed = true }
    }
  }

  private func showNotes(_ show: Bool) {
    withAnimation(Island.spring) { readingNotes = show }
  }

  @ViewBuilder private func main(_ event: CalendarEvent) -> some View {
    let capabilities = data.capabilities(for: event)
    let notes = event.description.map { DescriptionHTML.preview(from: DescriptionHTML.attributed(from: $0)) } ?? ""
    VStack(alignment: .leading, spacing: 12) {
      header(event)

      VStack(alignment: .leading, spacing: 10) {
        DetailRow(symbol: "clock") {
          VStack(alignment: .leading, spacing: 1) {
            Text(timeText(event))
              .font(.sans(TextSize.sm, .medium))
              .foregroundStyle(Palette.foreground)
            Text(relative(event))
              .font(.sans(TextSize.xs))
          }
        }
        let others = ZoneRailPrefs.zones(railZones)
        if !event.allDay, !others.isEmpty {
          DetailRow(symbol: "globe") {
            VStack(alignment: .leading, spacing: 4) {
              ForEach(
                eventTimesInZones(
                  startMs: event.startMs, endMs: event.endMs, zones: others,
                  primary: navigation.zone, use24h: navigation.use24h
                ),
                id: \.identifier
              ) { time in
                ZoneTimeRow(time: time)
              }
            }
          }
        }
        if let reminders = reminderText(event) {
          DetailRow(symbol: "bell") { Text(reminders) }
        }
        if event.providerSeriesId != nil {
          DetailRow(symbol: "repeat") {
            if let text = recurrenceText() {
              Text(text)
            } else {
              ProgressView().controlSize(.mini).accessibilityLabel("Loading recurrence")
            }
          }
        }
        if let url = event.conferenceUrl.flatMap(URL.init(string:)) {
          ConferenceRow(event: event, url: url, data: data)
        }
        if let location = event.location, !location.isEmpty {
          DetailRow(symbol: "mappin.and.ellipse") {
            Link(destination: Self.mapsURL(location)) {
              Text(location).multilineTextAlignment(.leading).lineLimit(3)
            }
            .foregroundStyle(Palette.mutedForeground)
            .help("Open in Maps")
          }
        }
        if let attendees = event.attendees, !attendees.isEmpty {
          if capabilities.canSeeGuests {
            GuestSection(guests: attendees, people: data.people)
          } else {
            DetailRow(symbol: "person.2") { Text("Guest list hidden by the organiser") }
          }
        }
        if !notes.isEmpty {
          DetailRow(symbol: "text.alignleft") {
            NotesPreview(text: notes) { showNotes(true) }
          }
        }
      }
      .foregroundStyle(Palette.mutedForeground)

      if capabilities.canRespond {
        RsvpControl(event: event, current: capabilities.selfResponse, data: data)
      }

      DetailFooter(event: event, capabilities: capabilities, island: island, data: data, navigation: navigation)
    }
  }

  // MARK: Header

  private func header(_ event: CalendarEvent) -> some View {
    HStack(alignment: .top, spacing: 10) {
      // The colour rail, as on the event's card.
      Capsule()
        .fill(Palette.event(data.colorKey(for: event)))
        .frame(width: 3)
        .padding(.vertical, 2)
      VStack(alignment: .leading, spacing: 3) {
        Text(event.title)
          .font(.sans(TextSize.base, .semibold))
          .lineLimit(2)
          .textSelection(.enabled)
        HStack(spacing: 5) {
          if let calendar = data.calendar(id: event.localCalendarId) {
            Circle().fill(Palette.event(calendar.colorKey)).frame(width: 7, height: 7)
            Text(calendar.displayName).lineLimit(1)
            Text("·")
          }
          Text(event.busy == false ? "Free" : "Busy")
          if event.visibility == "private" {
            Image(systemName: "lock").font(.system(size: 10, weight: .semibold)).help("Private")
          }
        }
        .font(.sans(TextSize.xs))
        .foregroundStyle(Palette.mutedForeground)
      }
      Spacer(minLength: 0)
      IslandCloseButton(action: island.close)
    }
    .fixedSize(horizontal: false, vertical: true)
  }

  // MARK: Text

  /// "Wed 18 Nov, 4:00 – 5:00 PM", or the day or days of an all-day event.
  private func timeText(_ event: CalendarEvent) -> String {
    let zone = navigation.zone
    let day = "EEE d MMM"
    switch eventTimeParts(event, use24h: navigation.use24h, zone: zone) {
    case .allDay(let start, let lastDay):
      return zone.isSameDay(start, lastDay)
        ? zone.format(start, day)
        : "\(zone.format(start, day)) – \(zone.format(lastDay, day))"
    case .timed(let start, _, let pattern, let endText):
      return "\(zone.format(start, "\(day), \(pattern)")) – \(endText)"
    }
  }

  /// "in 3 hours", "2 days ago".
  private func relative(_ event: CalendarEvent) -> String {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    formatter.dateTimeStyle = .numeric
    return formatter.localizedString(for: Date(ms: event.startMs), relativeTo: .now)
  }

  /// The event's popup reminders; with none of its own, the calendar's
  /// defaults it falls back on. Nil for a public calendar's event, which has
  /// no reminders of the user's.
  private func reminderText(_ event: CalendarEvent) -> String? {
    guard event.connectionId != nil else { return nil }
    let use24h = navigation.use24h
    guard let reminders = event.reminders else {
      guard let defaults = data.defaultReminders(allDay: event.allDay), !defaults.isEmpty else { return nil }
      return "Default · " + defaults.map { ReminderPresets.label($0, allDay: event.allDay, use24h: use24h) }.joined(separator: " · ")
    }
    let popups = reminders.filter { $0.method == "popup" }.map(\.minutes).sorted()
    if popups.isEmpty { return "No reminders" }
    return popups.map { ReminderPresets.label($0, allDay: event.allDay, use24h: use24h) }.joined(separator: " · ")
  }

  private func recurrenceText() -> String? {
    let series = event.providerSeriesId ?? event.id
    if case .some(.some(let lines)) = recurrence.value {
      let text = RecurrenceSummary.summarize(lines, zone: navigation.zone) ?? "Part of a repeating series"
      data.rememberRecurrence(text, series: series, zone: navigation.zone)
      return text
    }
    // Read before for this series: show it while the subscription catches up.
    if let known = data.recurrenceSummary(series: series, zone: navigation.zone) { return known }
    switch recurrence.value {
    case .some(.some):
      return nil
    case .some(.none):
      return recurrenceFailed ? "Part of a repeating series" : nil
    case .none:
      // The query itself failed (a public calendar's row has no rule to
      // read), or is taking too long: say what is known.
      return recurrence.error != nil || recurrenceFailed ? "Part of a repeating series" : nil
    }
  }

  /// A web address opens as itself; anything else is searched on Google Maps.
  static func mapsURL(_ location: String) -> URL {
    if location.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil,
      let url = URL(string: location)
    {
      return url
    }
    var components = URLComponents(string: "https://www.google.com/maps/search/")!
    components.queryItems = [URLQueryItem(name: "api", value: "1"), URLQueryItem(name: "query", value: location)]
    return components.url!
  }
}

// MARK: - Rows

/// An icon and what it describes, in the muted detail colour.
private struct DetailRow<Content: View>: View {
  let symbol: String
  @ViewBuilder var content: Content

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 12, weight: .medium))
        .frame(width: 16, height: 17)
      content
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

/// The event in one of the rail's other zones: day or night there, the
/// zone's code, its times and, when they differ, its days.
private struct ZoneTimeRow: View {
  let time: ZoneEventTime

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: time.isDaytime ? "sun.max.fill" : "moon.fill")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(time.isDaytime ? Palette.event(3) : Palette.mutedForeground)
        .frame(width: 12, height: 17)
      Text(time.code)
        .font(.sans(TextSize.xs, .semibold))
        .tracking(0.4)
        .frame(width: 30, alignment: .leading)
      Text(time.time)
        .monospacedDigit()
      if let days = time.days {
        Text(days)
          .font(.sans(TextSize.xs))
      }
    }
    .lineLimit(1)
    .help(zoneShortLabel(time.identifier))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      "\(zoneShortLabel(time.identifier)): \(time.time)\(time.days.map { ", \($0)" } ?? ""), \(time.isDaytime ? "daytime" : "night")"
    )
  }
}

/// The video call: which service and its address, a copy button, and Join.
private struct ConferenceRow: View {
  let event: CalendarEvent
  let url: URL
  let data: CalendarData
  @Environment(\.openURL) private var openURL

  private var isMeet: Bool { event.conferenceType == "hangoutsMeet" }
  private var name: String { event.conferenceName ?? (isMeet ? "Google Meet" : "Video call") }

  var body: some View {
    HStack(spacing: 10) {
      Group {
        if isMeet {
          Image("GoogleMeet").resizable().scaledToFit()
        } else {
          Image(systemName: "video").font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.meet)
        }
      }
      .frame(width: 16, height: 16)
      VStack(alignment: .leading, spacing: 1) {
        Text(name).font(.sans(TextSize.sm, .medium)).foregroundStyle(Palette.foreground)
        Text(url.absoluteString.replacing(#/^https?:\/\//#, with: ""))
          .font(.sans(TextSize.xs))
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 0)
      IconAction(symbol: "doc.on.doc", label: "Copy \(name) link") {
        copy(url.absoluteString)
        data.announce("Video link copied")
      }
      JoinButton { openURL(url) }
        .help("Join \(name)")
    }
  }
}

/// The web's emerald Join pill. Drawn rather than stock: a prominent stock
/// button turns grey whenever the window is not the key one.
private struct JoinButton: View {
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: "video.fill").font(.system(size: 11, weight: .semibold))
        Text("Join").font(.sans(TextSize.sm, .semibold))
      }
      .foregroundStyle(.white)
      .padding(.horizontal, 12)
      .frame(height: 28)
      .background(Palette.meet.opacity(hovering ? 0.9 : 1), in: .capsule)
      .contentShape(.capsule)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

/// The description's first lines; pressing them opens the whole of it.
private struct NotesPreview: View {
  let text: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Text(text)
        .lineLimit(4)
        .multilineTextAlignment(.leading)
        .foregroundStyle(hovering ? Palette.foreground : Palette.mutedForeground)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .help("Show the whole description")
  }
}

// MARK: - Guests

/// The answers' groups, in the order Google lists them, each with the colour
/// of its avatar dot (the web's `RSVP_GROUPS`).
private enum RsvpGroup: CaseIterable {
  case going, maybe, notGoing, awaiting

  init(_ status: String?) {
    switch status {
    case "accepted": self = .going
    case "tentative": self = .maybe
    case "declined": self = .notGoing
    default: self = .awaiting
    }
  }

  var label: String {
    switch self {
    case .going: "Going"
    case .maybe: "Maybe"
    case .notGoing: "Not going"
    case .awaiting: "Awaiting"
    }
  }

  var color: Color {
    switch self {
    case .going: Palette.event(.event4)
    case .maybe: Palette.event(.event3)
    case .notGoing: Palette.destructive
    case .awaiting: Palette.mutedForeground
    }
  }
}

/// Guests as an overlapping avatar stack with an answer dot on each and a
/// tally under it; pressing it lists everyone by answer.
private struct GuestSection: View {
  let guests: [EventAttendee]
  let people: [PersonRow]
  @State private var expanded = EventDetailPanel.debugScreen == "guests"

  private static let maxAvatars = 6

  private var photos: [String: String] {
    Dictionary(
      people.compactMap { person in person.photoUrl.map { (person.email.lowercased(), $0) } },
      uniquingKeysWith: { first, _ in first }
    )
  }

  private var groups: [(group: RsvpGroup, guests: [EventAttendee])] {
    RsvpGroup.allCases.compactMap { group in
      let members = guests.filter { RsvpGroup($0.responseStatus) == group }
      return members.isEmpty ? nil : (group, members)
    }
  }

  var body: some View {
    let photos = photos
    DetailRow(symbol: "person.2") {
      VStack(alignment: .leading, spacing: 8) {
        Button {
          withAnimation(Island.spring) { expanded.toggle() }
        } label: {
          VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: -6) {
              ForEach(guests.prefix(Self.maxAvatars), id: \.email) { guest in
                PersonAvatar(name: guest.displayName, email: guest.email, photoUrl: photos[guest.email.lowercased()], size: 24)
                  .overlay { Circle().strokeBorder(Palette.popover, lineWidth: 2) }
                  .overlay(alignment: .bottomTrailing) {
                    Circle()
                      .fill(RsvpGroup(guest.responseStatus).color)
                      .frame(width: 9, height: 9)
                      .overlay { Circle().strokeBorder(Palette.popover, lineWidth: 1.5) }
                      .offset(x: 1, y: 1)
                  }
              }
              if guests.count > Self.maxAvatars {
                Text("+\(guests.count - Self.maxAvatars)")
                  .font(.sans(9, .semibold))
                  .foregroundStyle(Palette.mutedForeground)
                  .frame(width: 24, height: 24)
                  .background(Palette.muted, in: .circle)
                  .overlay { Circle().strokeBorder(Palette.popover, lineWidth: 2) }
              }
            }
            HStack(spacing: 4) {
              Text(groups.map { "\($0.guests.count) \($0.group.label.lowercased())" }.joined(separator: ", "))
              Image(systemName: "chevron.down")
                .font(.system(size: 8, weight: .bold))
                .rotationEffect(.degrees(expanded ? 180 : 0))
            }
            .font(.sans(TextSize.xs))
          }
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(guests.count) guests")
        .accessibilityHint(expanded ? "Hides the guest list" : "Shows the guest list")

        if expanded {
          ScrollView {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(groups, id: \.group) { entry in
                VStack(alignment: .leading, spacing: 2) {
                  Text("\(entry.guests.count) \(entry.group.label)")
                    .font(.sans(TextSize.xs, .medium))
                    .foregroundStyle(Palette.foreground)
                  ForEach(entry.guests, id: \.email) { guest in
                    GuestRow(guest: guest, photoUrl: photos[guest.email.lowercased()])
                  }
                }
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .frame(maxHeight: 220)
          .fixedSize(horizontal: false, vertical: true)
          .transition(.opacity.combined(with: .move(edge: .top)))
        }
      }
    }
  }
}

/// One guest: picture, name over address, a crown for the organiser.
private struct GuestRow: View {
  let guest: EventAttendee
  let photoUrl: String?

  var body: some View {
    HStack(spacing: 8) {
      PersonAvatar(name: guest.displayName, email: guest.email, photoUrl: photoUrl, size: 26)
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 4) {
          if guest.organizer == true {
            Image(systemName: "crown.fill")
              .font(.system(size: 9))
              .foregroundStyle(.orange)
              .help("Organiser")
          }
          Text(guest.displayName ?? guest.email)
            .font(.sans(TextSize.sm))
            .foregroundStyle(Palette.foreground)
            .lineLimit(1)
          if guest.isSelf == true {
            Text("(you)").font(.sans(TextSize.xs)).foregroundStyle(Palette.mutedForeground)
          }
        }
        if guest.displayName != nil {
          Text(guest.email)
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
    }
    .padding(.vertical, 2)
  }
}

// MARK: - RSVP

/// "Are you going?": Going, Maybe, No. The choice shows at once and is held
/// until the synced row agrees; a failed reply puts it back.
private struct RsvpControl: View {
  let event: CalendarEvent
  let current: String?
  let data: CalendarData

  @State private var optimistic: String?
  @Namespace private var thumb

  private static let choices = [("accepted", "Going"), ("tentative", "Maybe"), ("declined", "No")]

  var body: some View {
    let active = optimistic ?? current
    VStack(alignment: .leading, spacing: 6) {
      Text("Are you going?")
        .font(.sans(TextSize.xs))
        .foregroundStyle(Palette.mutedForeground)
      HStack(spacing: 2) {
        ForEach(Self.choices, id: \.0) { status, label in
          SegmentButton(label: label, active: active == status, thumb: thumb) { choose(status) }
        }
      }
      .padding(3)
      .background(Palette.foreground.opacity(0.06), in: .rect(cornerRadius: 10, style: .continuous))
    }
    .onChange(of: current) { _, current in
      if optimistic != nil, current == optimistic { optimistic = nil }
    }
  }

  private func choose(_ status: String) {
    guard status != (optimistic ?? current) else { return }
    withAnimation(.snappy(duration: 0.2)) { optimistic = status }
    Task {
      do {
        try await data.respond(to: event, status: status)
      } catch {
        withAnimation(.snappy(duration: 0.2)) { optimistic = nil }
        data.announce("Couldn't send your reply.")
      }
    }
  }
}

/// One segment, drawn the way a Mac segmented control is: the chosen one
/// lifted on a light thumb that slides between choices, the others plain.
private struct SegmentButton: View {
  let label: String
  let active: Bool
  let thumb: Namespace.ID
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.sans(TextSize.sm, .medium))
        .foregroundStyle(active || hovering ? Palette.foreground : Palette.mutedForeground)
        .frame(maxWidth: .infinity)
        .frame(height: 26)
        .background {
          if active {
            SegmentThumb(cornerRadius: 7)
              .matchedGeometryEffect(id: "thumb", in: thumb)
          } else if hovering {
            RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Palette.foreground.opacity(0.04))
          }
        }
        .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .accessibilityAddTraits(active ? .isSelected : [])
  }
}

// MARK: - Footer

/// The panel's last line, drawn like a Mac window's bottom bar: Edit on the
/// left, and a quiet red pill for Delete (or a grey one for Remove, for an
/// invitation) on the right. Everything sits on one 28pt line.
private struct DetailFooter: View {
  let event: CalendarEvent
  let capabilities: EventCapabilities
  let island: Island
  let data: CalendarData
  let navigation: CalendarNavigation

  var body: some View {
    HStack(spacing: 0) {
      if capabilities.canEdit {
        EditButton(action: edit)
      }
      Spacer(minLength: 12)
      if capabilities.canDelete || capabilities.canRemoveSelf {
        DeleteControl(
          event: event,
          destructive: capabilities.canDelete,
          isOrganizer: capabilities.isOrganizer,
          island: island,
          data: data
        )
      }
    }
    .frame(height: 28)
    .padding(.top, 2)
  }

  /// The event in the edit form, its fields filled from it.
  private func edit() {
    island.openEdit(event, draft: EventDraft.editing(event, zone: navigation.zone))
  }
}

/// Edit: a pencil and its label in a quiet capsule, the Delete pill's
/// neutral twin. ⌘E from anywhere in the panel.
private struct EditButton: View {
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: "pencil")
          .font(.system(size: 11, weight: .semibold))
        Text("Edit").font(.sans(TextSize.sm, .medium))
      }
      .foregroundStyle(Palette.foreground)
      .padding(.horizontal, 11)
      .frame(height: 28)
      .background(Palette.foreground.opacity(hovering ? 0.14 : 0.08), in: .capsule)
      .contentShape(.capsule)
    }
    .buttonStyle(.plain)
    .keyboardShortcut("e", modifiers: .command)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
    .help("Edit event (⌘E)")
  }
}

/// Delete in two presses: the first turns the pill solid red and asks
/// "Delete?", and it calms down again after three seconds. A repeating event
/// opens the system menu of which instances instead, and that choice is the
/// confirmation.
private struct DeleteControl: View {
  let event: CalendarEvent
  let destructive: Bool
  let isOrganizer: Bool
  let island: Island
  let data: CalendarData

  @State private var armed = false
  @State private var busy = false
  @State private var hovering = false
  /// Kept across retries of the same scope, so the server acts once.
  @State private var operation: (scope: String, id: String)?

  private var label: String { destructive ? "Delete" : "Remove" }
  private var busyLabel: String { destructive ? "Deleting…" : "Removing…" }

  var body: some View {
    Group {
      if event.providerSeriesId != nil {
        Menu {
          Section(destructive ? "Delete" : "Remove from my calendar") {
            Button("This event", role: .destructive) { remove("thisEvent") }
            if isOrganizer {
              Button("This and following events", role: .destructive) { remove("thisAndFollowing") }
            }
            Button("All events", role: .destructive) { remove("allEvents") }
          }
        } label: {
          pill(text: busy ? busyLabel : label, chevron: !busy)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
      } else {
        Button {
          if armed { remove("thisEvent") } else { arm() }
        } label: {
          pill(text: busy ? busyLabel : armed ? "\(label)?" : label, chevron: false)
        }
        .buttonStyle(.plain)
      }
    }
    .disabled(busy)
    .onHover { hovering = $0 }
    .help(destructive ? "Delete this event for everyone" : "Remove this event from your calendar")
    .animation(.snappy(duration: 0.2), value: armed)
    .animation(.easeOut(duration: 0.12), value: hovering)
  }

  /// Trash, label, and for a repeating event a small chevron: a capsule
  /// tinted red for a delete, grey for a remove, solid red once armed.
  private func pill(text: String, chevron: Bool) -> some View {
    let tint = destructive ? Palette.destructive : Palette.foreground
    return HStack(spacing: 5) {
      if busy {
        ProgressView().controlSize(.mini)
      } else {
        Image(systemName: destructive ? "trash" : "calendar.badge.minus")
          .font(.system(size: 11, weight: .semibold))
      }
      Text(text).font(.sans(TextSize.sm, .medium))
      if chevron {
        Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).opacity(0.7)
      }
    }
    .foregroundStyle(armed && destructive ? .white : tint)
    .padding(.horizontal, 11)
    .frame(height: 28)
    .background {
      Capsule().fill(
        armed && destructive ? Palette.destructive : tint.opacity(hovering ? 0.16 : 0.1)
      )
    }
    .contentShape(.capsule)
  }

  private func arm() {
    armed = true
    Task {
      try? await Task.sleep(for: .seconds(3))
      armed = false
    }
  }

  private func remove(_ scope: String) {
    if operation?.scope != scope { operation = (scope, UUID().uuidString) }
    let id = operation!.id
    busy = true
    Task {
      do {
        try await data.deleteEvent(event, scope: scope, operationId: id)
        island.close()
      } catch {
        busy = false
        armed = false
        data.announce(destructive ? "Couldn't delete the event." : "Couldn't remove the event.")
      }
    }
  }
}

/// A glyph button with a tooltip and a round hover. With `column`, it takes
/// only the 16pt width of the row icons, so it lines up under them, and the
/// hover circle spills past that.
private struct IconAction: View {
  let symbol: String
  let label: String
  var column = false
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(hovering ? Palette.foreground : Palette.mutedForeground)
        .frame(width: column ? 16 : 28, height: 28)
        .background {
          Circle()
            .fill(Palette.foreground.opacity(hovering ? 0.08 : 0))
            .frame(width: 28, height: 28)
        }
        .contentShape(.rect.inset(by: column ? -6 : 0))
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
    .help(label)
    .accessibilityLabel(label)
  }
}

private func copy(_ text: String) {
  NSPasteboard.general.clearContents()
  NSPasteboard.general.setString(text, forType: .string)
}

extension View {
  /// Makes an event's card open that event in the island.
  func opensEvent(_ event: CalendarEvent) -> some View {
    modifier(OpensEvent(event: event))
  }
}

private struct OpensEvent: ViewModifier {
  let event: CalendarEvent
  @Environment(Island.self) private var island

  func body(content: Content) -> some View {
    content
      .contentShape(.rect)
      .onTapGesture { island.open(.event(event)) }
      .accessibilityAddTraits(.isButton)
  }
}
