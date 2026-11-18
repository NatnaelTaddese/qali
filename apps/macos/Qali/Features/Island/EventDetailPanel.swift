import QaliDomain
import SwiftUI

/// The island's event face: a read-only summary of one event (the first cut
/// of the web's `EventDetail`). Editing, RSVP and reminders come later.
struct EventDetailPanel: View {
  let event: CalendarEvent
  let island: Island
  let data: CalendarData
  let navigation: CalendarNavigation

  @Environment(\.openURL) private var openURL

  private var hue: Color { Palette.event(data.colorKey(for: event)) }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Capsule()
          .fill(hue)
          .frame(width: 3)
          .padding(.vertical, 2)
        VStack(alignment: .leading, spacing: 2) {
          Text(event.title)
            .font(.sans(TextSize.lg, .semibold))
            .lineLimit(3)
          Text(when)
            .font(.sans(TextSize.sm))
            .foregroundStyle(Palette.mutedForeground)
        }
        Spacer(minLength: 0)
        IslandCloseButton(action: island.close)
      }
      .fixedSize(horizontal: false, vertical: true)

      if let url = event.conferenceUrl.flatMap(URL.init(string:)) {
        Button {
          openURL(url)
        } label: {
          Label {
            Text("Join \(event.conferenceName ?? "video call")")
          } icon: {
            // The Meet mark for a Meet call, as the web's detail card shows it.
            if event.conferenceType == "hangoutsMeet" {
              Image("GoogleMeet").resizable().scaledToFit().frame(width: 16, height: 16)
            } else {
              Image(systemName: "video")
            }
          }
          .font(.sans(TextSize.sm, .medium))
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .tint(Palette.primary)
        .foregroundStyle(Palette.primaryForeground)
        .controlSize(.large)
      }

      VStack(alignment: .leading, spacing: 8) {
        if let calendar = data.calendar(id: event.localCalendarId) {
          row("calendar") {
            HStack(spacing: 6) {
              Circle().fill(Palette.event(calendar.colorKey)).frame(width: 8, height: 8)
              Text(calendar.displayName)
            }
          }
        }
        if let location = event.location, !location.isEmpty {
          row("mappin.and.ellipse") { Text(location).lineLimit(2) }
        }
        if let guests = guests, !guests.isEmpty {
          row("person.2") {
            VStack(alignment: .leading, spacing: 3) {
              ForEach(guests.prefix(5), id: \.email) { guest in
                HStack(spacing: 6) {
                  Text(guest.displayName ?? guest.email)
                    .lineLimit(1)
                    .truncationMode(.middle)
                  if let status = Self.statusLabel(guest.responseStatus) {
                    Text(status).foregroundStyle(Palette.mutedForeground)
                  }
                }
              }
              if guests.count > 5 {
                Text("+\(guests.count - 5) more").foregroundStyle(Palette.mutedForeground)
              }
            }
          }
        }
        if let notes = notes {
          row("text.alignleft") {
            Text(notes)
              .lineLimit(6)
              .foregroundStyle(Palette.foreground.opacity(0.85))
          }
        }
      }
      .font(.sans(TextSize.sm))

      if let link = event.htmlLink.flatMap(URL.init(string:)) {
        Button("Open in Google Calendar") { openURL(link) }
          .buttonStyle(.plain)
          .font(.sans(TextSize.xs, .medium))
          .foregroundStyle(Palette.link)
      }
    }
    .foregroundStyle(Palette.foreground)
  }

  private func row(_ symbol: String, @ViewBuilder content: () -> some View) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Palette.mutedForeground)
        .frame(width: 16)
      content()
      Spacer(minLength: 0)
    }
  }

  /// "Mon 16 Nov · 9:00 – 10:00 AM", "Mon 16 Nov · All day", or a day span.
  private var when: String {
    let zone = navigation.zone
    let day = "EEE d MMM"
    switch eventTimeParts(event, use24h: navigation.use24h, zone: zone) {
    case .allDay(let start, let lastDay):
      return zone.isSameDay(start, lastDay)
        ? "\(zone.format(start, day)) · All day"
        : "\(zone.format(start, day)) – \(zone.format(lastDay, day))"
    case .timed(let start, _, let pattern, let endText):
      return "\(zone.format(start, day)) · \(zone.format(start, pattern)) – \(endText)"
    }
  }

  /// The guest list, when the event shows it to this user.
  private var guests: [EventAttendee]? {
    guard data.capabilities(for: event).canSeeGuests else { return nil }
    return event.attendees
  }

  /// The description as plain text: Google sends HTML.
  private var notes: String? {
    guard let description = event.description else { return nil }
    let text = description
      .replacingOccurrences(of: "<br\\s*/?>|</p>|</div>|</li>", with: "\n", options: [.regularExpression, .caseInsensitive])
      .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
      .replacingOccurrences(of: "&nbsp;", with: " ")
      .replacingOccurrences(of: "&amp;", with: "&")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  private static func statusLabel(_ status: String?) -> String? {
    switch status {
    case "accepted": "Going"
    case "tentative": "Maybe"
    case "declined": "Not going"
    default: nil
    }
  }
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
