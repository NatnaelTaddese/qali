import AppKit
import QaliDomain
import SwiftUI

/// The island's booking link face (the web's availability panel, minus the
/// form, which lives in Settings → Booking Link): whether the page is live,
/// the link to share, and the requests waiting for an answer, a drill-down
/// away.
struct BookingPanel: View {
  let island: Island
  let data: CalendarData
  let navigation: CalendarNavigation
  @Environment(AppModel.self) private var model

  @State private var showingRequests: Bool
  @State private var copied = false
  @State private var preparingPaint = false
  /// The request cards' natural height, so the list is no taller.
  @State private var listHeight: CGFloat?

  private static let maxListHeight: CGFloat = 420

  init(island: Island, data: CalendarData, navigation: CalendarNavigation) {
    self.island = island
    self.data = data
    self.navigation = navigation
    // As on the web, a dock opened while people are waiting goes straight
    // to them.
    var requests = !data.booking.pending.isEmpty
    #if DEBUG
      if let screen = UserDefaults.standard.string(forKey: "QaliBookingScreen") { requests = screen == "requests" }
    #endif
    _showingRequests = State(initialValue: requests)
  }

  private var booking: BookingData { data.booking }

  var body: some View {
    ZStack(alignment: .topLeading) {
      if showingRequests {
        requests
          .escapeGoesBack(island: island) { show(requests: false) }
          .transition(.drillDown(forward: true))
      } else {
        main
          .transition(.drillDown(forward: false))
      }
    }
    .font(.sans(TextSize.sm))
    .foregroundStyle(Palette.foreground)
    // The last request answered leaves an empty list: go back.
    .onChange(of: booking.pending.isEmpty) { _, empty in
      if empty, showingRequests { show(requests: false) }
    }
  }

  private func show(requests: Bool) {
    withAnimation(Island.spring) { showingRequests = requests }
  }

  // MARK: Main

  @ViewBuilder private var main: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 1) {
          Text("Booking link").font(.sans(TextSize.sm, .medium))
          Text("Share it and people can request a time")
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
        }
        Spacer(minLength: 0)
        IslandCloseButton(action: island.close)
      }

      switch booking.page {
      case .none:
        ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 80)
      case .some(.none):
        setUp
      case .some(.some(let page)):
        linkCard(page)
        if !booking.pending.isEmpty {
          PanelRow(
            symbol: "tray.full",
            title: "Pending requests",
            detail: nil,
            badge: booking.pending.count,
            trailing: "Review"
          ) { show(requests: true) }
        }
        VStack(spacing: 2) {
          PanelRow(
            symbol: "calendar.day.timeline.left",
            title: "Set specific dates",
            detail: "Paint single days on the calendar",
            busy: preparingPaint
          ) { paint() }
          PanelRow(symbol: "slider.horizontal.3", title: "Edit booking page…", detail: summary(page)) {
            model.openSettingsPane?(.booking)
          }
        }
      }
    }
  }

  /// Before the first save: what this is, and where to set it up.
  private var setUp: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Pick the hours you're open, and anyone with your link can ask for a time. You confirm each request before it goes on your calendar.")
        .font(.sans(TextSize.xs))
        .foregroundStyle(Palette.mutedForeground)
        .fixedSize(horizontal: false, vertical: true)
      HStack {
        Spacer()
        Button {
          model.openSettingsPane?(.booking)
        } label: {
          Text("Set Up Booking Link…")
            .font(.sans(TextSize.sm, .medium))
            .padding(.horizontal, 4)
        }
        .modifier(PrimaryButton())
      }
    }
  }

  /// Live or paused, and the link with copy and open.
  private func linkCard(_ page: BookingPage) -> some View {
    let url = BookingData.publicURL(slug: page.slug)
    return VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Circle()
          .fill(page.enabled ? Palette.available : Palette.mutedForeground.opacity(0.4))
          .frame(width: 7, height: 7)
        Text(page.enabled ? "Live" : "Paused")
          .font(.sans(TextSize.xs, .medium))
        Text(page.enabled ? "People can request a time" : "Hidden, not taking requests")
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
          .lineLimit(1)
      }
      HStack(spacing: 4) {
        Image(systemName: "link")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(Palette.mutedForeground)
          .frame(width: 16)
        // A long slug gives up the host first, never its own end.
        (Text(BookingData.publicPrefix).foregroundStyle(Palette.mutedForeground)
          + Text(page.slug).font(.sans(TextSize.sm, .medium)))
          .font(.sans(TextSize.sm))
          .lineLimit(1)
          .truncationMode(.head)
          .textSelection(.enabled)
        Spacer(minLength: 4)
        IconButton(symbol: copied ? "checkmark" : "doc.on.doc", label: copied ? "Copied" : "Copy link") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(url.absoluteString, forType: .string)
          copied = true
          Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
          }
        }
        IconButton(symbol: "arrow.up.right.square", label: "Open in browser") {
          NSWorkspace.shared.open(url)
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(Palette.foreground.opacity(0.05), in: .rect(cornerRadius: 12, style: .continuous))
  }

  /// "30 min · 2 hours' notice · 60 days ahead".
  private func summary(_ page: BookingPage) -> String {
    let notice = Int((page.minNoticeMinutes / 60).rounded())
    let noticeText = notice == 0 ? "no notice" : notice == 1 ? "1 hour's notice" : "\(notice) hours' notice"
    return "\(Int(page.slotMinutes)) min · \(noticeText) · \(Int(page.horizonDays)) days ahead"
  }

  private func paint() {
    guard !preparingPaint else { return }
    preparingPaint = true
    Task {
      await booking.beginPainting(zone: navigation.zone)
      preparingPaint = false
    }
  }

  // MARK: Requests

  private var requests: some View {
    let pending = booking.pending
    return VStack(alignment: .leading, spacing: 10) {
      BackButton(title: "Booking link") { show(requests: false) }
        .help("Back to the booking link (Esc)")
      VStack(alignment: .leading, spacing: 1) {
        Text("Pending requests").font(.sans(TextSize.sm, .medium))
        Text(pending.count == 1 ? "1 person is waiting for a response" : "\(pending.count) people are waiting for a response")
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
      }
      // As tall as the cards, up to a cap; past it the list scrolls on its
      // own and the screen above stays put.
      ScrollView {
        VStack(spacing: 8) {
          ForEach(pending) { request in
            RequestCard(booking: request, data: data, navigation: navigation) {
              island.open(.bookingRequest(request))
              navigation.reveal(booking: request)
            }
          }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listHeight = $0 }
      }
      .scrollIndicators(.automatic)
      .frame(height: min(listHeight ?? 200, Self.maxListHeight))
    }
  }
}

/// One pending request as a card: who, when, their message, and the answer.
private struct RequestCard: View {
  let booking: Booking
  let data: CalendarData
  let navigation: CalendarNavigation
  /// Shows the request on the grid.
  let reveal: () -> Void

  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        VStack(alignment: .leading, spacing: 1) {
          Text(booking.requesterName)
            .font(.sans(TextSize.sm, .medium))
            .lineLimit(1)
          Text(booking.requesterEmail)
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
            .lineLimit(1)
            .truncationMode(.middle)
            .textSelection(.enabled)
        }
        Spacer(minLength: 4)
        Text(Date(ms: booking.createdAt), format: .relative(presentation: .named))
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
      }

      Button(action: reveal) {
        HStack(spacing: 6) {
          Image(systemName: "clock")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Palette.mutedForeground)
          VStack(alignment: .leading, spacing: 0) {
            Text(bookingTimeLabel(booking, zone: navigation.zone, use24h: navigation.use24h))
              .font(.sans(TextSize.xs, .medium))
            Text("Their time zone: \(booking.timeZone.replacingOccurrences(of: "_", with: " "))")
              .font(.sans(TextSize.xs))
              .foregroundStyle(Palette.mutedForeground)
          }
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .help("Show on the calendar")

      if let note = booking.note, !note.isEmpty {
        VStack(alignment: .leading, spacing: 3) {
          Text("Their message, written by the visitor and not verified")
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
          Text(note)
            .font(.sans(TextSize.sm))
            .lineLimit(expanded ? nil : 3)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
          if note.count > 140 {
            Button(expanded ? "Show less" : "Show more") {
              withAnimation(Island.spring) { expanded.toggle() }
            }
            .buttonStyle(.plain)
            .font(.sans(TextSize.xs, .medium))
            .foregroundStyle(Palette.mutedForeground)
          }
        }
      }

      DecisionButtons(booking: booking, store: data.booking)
    }
    .padding(12)
    .background(Palette.foreground.opacity(0.05), in: .rect(cornerRadius: 12, style: .continuous))
    .overlay(alignment: .leading) {
      Capsule().fill(Palette.primary.opacity(0.7)).frame(width: 3).padding(.vertical, 12).padding(.leading, 4)
    }
  }
}

/// One request on its own: opened from its block on the grid or from its
/// notification (the web's `BookingRequestPanel`). It follows the live row,
/// so a decision made elsewhere shows here.
struct BookingRequestPanel: View {
  let island: Island
  let data: CalendarData
  let navigation: CalendarNavigation
  @State private var live: LiveQuery<[Booking]>
  private let snapshot: Booking

  init(booking: Booking, island: Island, data: CalendarData, navigation: CalendarNavigation) {
    snapshot = booking
    self.island = island
    self.data = data
    self.navigation = navigation
    var fixture = false
    #if DEBUG
      fixture = BookingFixture.shared != nil
    #endif
    _live = State(
      initialValue: LiveQuery(
        data.client,
        ConvexAPI.listMyBookings,
        args: fixture ? nil : ["startMs": booking.startMs, "endMs": booking.endMs + 1]
      )
    )
  }

  private var booking: Booking {
    if let row = live.value?.first(where: { $0.id == snapshot.id }) { return row }
    // A fixture request answered here leaves the pending list.
    #if DEBUG
      if BookingFixture.shared != nil, !data.booking.pending.contains(where: { $0.id == snapshot.id }) {
        var decided = snapshot
        decided.status = "accepted"
        return decided
      }
    #endif
    return snapshot
  }

  var body: some View {
    let booking = booking
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 1) {
          Text(booking.requesterName)
            .font(.sans(TextSize.base, .semibold))
            .lineLimit(2)
          Text(bookingTimeLabel(booking, zone: navigation.zone, use24h: navigation.use24h))
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
        }
        Spacer(minLength: 0)
        IslandCloseButton(action: island.close)
      }

      VStack(alignment: .leading, spacing: 8) {
        InfoRow(symbol: "envelope") {
          Text(booking.requesterEmail).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
        }
        InfoRow(symbol: "globe") {
          Text("They booked this as \(booking.timeZone.replacingOccurrences(of: "_", with: " ")) time")
            .foregroundStyle(Palette.mutedForeground)
        }
        InfoRow(symbol: "clock.arrow.circlepath") {
          (Text("Requested ") + Text(Date(ms: booking.createdAt), format: .relative(presentation: .named)))
            .foregroundStyle(Palette.mutedForeground)
        }
      }
      .font(.sans(TextSize.sm))

      if let note = booking.note, !note.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          Text("Their message, written by the visitor and not verified")
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
          ScrollView {
            Text(note)
              .font(.sans(TextSize.sm))
              .frame(maxWidth: .infinity, alignment: .leading)
              .textSelection(.enabled)
          }
          .frame(maxHeight: 140)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
          .background(Palette.foreground.opacity(0.05), in: .rect(cornerRadius: 10, style: .continuous))
        }
      }

      if booking.isPending {
        DecisionButtons(booking: booking, store: data.booking) { island.close() }
      } else {
        HStack(spacing: 6) {
          Image(systemName: booking.status == "accepted" ? "checkmark.circle.fill" : "minus.circle")
            .foregroundStyle(booking.status == "accepted" ? Palette.available : Palette.mutedForeground)
          Text(statusText(booking.status))
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
        }
      }
    }
    .foregroundStyle(Palette.foreground)
  }

  private func statusText(_ status: String) -> String {
    switch status {
    case "accepted": "Confirmed. It's on your calendar."
    case "expired": "This request expired."
    default: "Declined."
    }
  }
}

/// Decline and Confirm, with the one in flight showing its progress.
private struct DecisionButtons: View {
  let booking: Booking
  let store: BookingData
  var done: () -> Void = {}

  var body: some View {
    let deciding = store.deciding
    let mine = deciding?.bookingId == booking.id ? deciding : nil
    HStack(spacing: 8) {
      Spacer(minLength: 0)
      Button {
        decide(accept: false)
      } label: {
        HStack(spacing: 6) {
          if mine?.accept == false { ProgressView().controlSize(.mini) }
          Text("Decline")
        }
        .font(.sans(TextSize.sm, .medium))
        .foregroundStyle(Palette.mutedForeground)
        .padding(.horizontal, 8)
        .frame(height: 28)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .disabled(deciding != nil)

      Button {
        decide(accept: true)
      } label: {
        HStack(spacing: 6) {
          if mine?.accept == true { ProgressView().controlSize(.mini) }
          Text(mine?.accept == true ? "Confirming…" : "Confirm")
        }
        .font(.sans(TextSize.sm, .medium))
        .padding(.horizontal, 4)
      }
      .modifier(PrimaryButton())
      .disabled(deciding != nil)
      .help("Add it to your calendar and invite \(booking.requesterName)")
    }
  }

  private func decide(accept: Bool) {
    Task {
      if await store.decide(booking, accept: accept) { done() }
    }
  }
}

/// The island's face while painting availability (the web's
/// `AvailabilityEditBar`): what the grid does now, and Done.
struct AvailabilityPaintBar: View {
  let ready: Bool
  let done: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      if ready {
        Image(systemName: "hand.draw")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(Palette.available)
      } else {
        ProgressView().controlSize(.small)
      }
      (Text(ready ? "Setting availability" : "Loading availability").font(.sans(TextSize.sm, .medium))
        + Text(ready ? "  ·  drag a day to add, click a block to remove" : "")
        .font(.sans(TextSize.sm))
        .foregroundStyle(Palette.mutedForeground))
        .lineLimit(1)
      Button(action: done) {
        Text("Done")
          .font(.sans(TextSize.sm, .medium))
          .padding(.horizontal, 4)
      }
      .modifier(PrimaryButton())
      .keyboardShortcut(.cancelAction)
      .help("Stop setting availability (Esc)")
    }
    .foregroundStyle(Palette.foreground)
  }
}

// MARK: - Pieces

/// "Mon, Nov 24 · 10:00 – 10:30 AM", in the working zone and clock.
func bookingTimeLabel(_ booking: Booking, zone: WorkingZone, use24h: Bool) -> String {
  let start = Date(ms: booking.startMs)
  let end = Date(ms: booking.endMs)
  let startTime = zone.format(start, timePattern(use24h: use24h, withDayPeriod: false))
  let endTime = zone.format(end, timePattern(use24h: use24h))
  return "\(zone.format(start, "EEE, MMM d")) · \(startTime) – \(endTime)"
}

/// A tappable row in a panel: glyph, title and detail, then a badge or a
/// trailing word and a chevron.
private struct PanelRow: View {
  let symbol: String
  let title: String
  let detail: String?
  var badge: Int?
  var trailing: String?
  var busy = false
  let action: () -> Void

  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Group {
          if busy {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: symbol).font(.system(size: 13, weight: .medium))
          }
        }
        .foregroundStyle(Palette.mutedForeground)
        .frame(width: 18)
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 6) {
            Text(title).font(.sans(TextSize.sm, .medium))
            if let badge {
              Text("\(badge)")
                .font(.sans(TextSize.xs, .semibold))
                .foregroundStyle(Palette.primaryForeground)
                .padding(.horizontal, 6)
                .frame(minWidth: 18, minHeight: 18)
                .background(Palette.primary, in: .capsule)
            }
          }
          if let detail {
            Text(detail)
              .font(.sans(TextSize.xs))
              .foregroundStyle(Palette.mutedForeground)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 4)
        if let trailing {
          Text(trailing).font(.sans(TextSize.xs)).foregroundStyle(Palette.mutedForeground)
        }
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(Palette.mutedForeground)
          .offset(x: hovering ? 2 : 0)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(Palette.foreground.opacity(hovering ? 0.08 : badge != nil ? 0.05 : 0))
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(busy)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
  }
}

/// A small glyph button with a hover fill.
private struct IconButton: View {
  let symbol: String
  let label: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(hovering ? Palette.foreground : Palette.mutedForeground)
        .frame(width: 26, height: 26)
        .background { Circle().fill(Palette.foreground.opacity(hovering ? 0.08 : 0)) }
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .accessibilityLabel(label)
    .help(label)
  }
}

private struct InfoRow<Content: View>: View {
  let symbol: String
  @ViewBuilder var content: Content

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Palette.mutedForeground)
        .frame(width: 16, height: 17)
      content.frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
