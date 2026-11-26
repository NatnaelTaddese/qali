import AppKit
import SwiftUI

/// The bottom island (the web's `BottomIsland`): one Liquid Glass shell at the
/// foot of the calendar. At rest it is the nav row, a pill; opening a panel
/// grows the same shell into a card around the new content, and closing
/// shrinks it back.
///
/// There is no scrim. A panel is dismissed by Escape, its own close button, or
/// a click anywhere else in the calendar, and that click still does what it
/// was aimed at.
struct BottomIsland: View {
  let island: Island
  let data: CalendarData
  let navigation: CalendarNavigation

  /// The shell's size, taken from whatever content is current.
  @State private var size: CGSize = .zero
  @State private var frame: CGRect = .zero
  @State private var outsideClicks = OutsideClickMonitor()

  /// Painting availability takes the island over, as on the web.
  private var painting: Bool { data.booking.isPainting }

  private var shape: RoundedRectangle {
    // The nav row is a pill; panels are cards, so they round less.
    RoundedRectangle(cornerRadius: island.view == nil || painting ? 23 : 20, style: .continuous)
  }

  var body: some View {
    VStack(spacing: 10) {
      TravelOffer(data: data)
      if let notice = data.notice {
        Text(notice)
          .font(.sans(TextSize.xs, .medium))
          .foregroundStyle(Palette.foreground)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .frame(maxWidth: 340)
          .glassEffect(.regular, in: .capsule)
          .transition(.opacity.combined(with: .offset(y: 6)))
      }

      Color.clear
        .frame(width: size.width, height: size.height)
        .overlay(alignment: .top) { content }
        .clipShape(shape)
        .glassEffect(.regular, in: shape)
        // Floats over the form, outside the shell's clip.
        .overlayPreferenceValue(GuestMatchesKey.self) { matches in
          GeometryReader { proxy in
            if let matches {
              let field = proxy[matches.anchor]
              GuestMatchesCard(matches: matches)
                .frame(width: field.width + 20)
                .frame(width: proxy.size.width, height: max(field.minY - 4, 0), alignment: .bottomLeading)
                .offset(x: field.minX - 10)
                .transition(.opacity.combined(with: .offset(y: 4)))
            }
          }
        }
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Dock")
    }
    .padding(.bottom, 22)
    .animation(.easeOut(duration: 0.2), value: data.notice)
    .background { shortcuts }
    // A half-filled create form is real work: only Escape or Cancel discards
    // it, never a click elsewhere (which may well be a drag for a new range).
    .onChange(of: island.view != nil && island.view?.holdsDraft != true && !painting, initial: true) { _, dismissable in
      outsideClicks.island = dismissable ? island : nil
    }
    // Painting starts from any face, the Settings window included; the
    // panel it came from closes, and Done brings back the nav row.
    .onChange(of: painting) { _, painting in
      if painting { island.close() }
    }
    .onChange(of: frame) { _, frame in
      outsideClicks.exempt = frame
      island.shellFrame = frame
    }
    .onDisappear { outsideClicks.island = nil }
    #if DEBUG
      // `-QaliIsland account|search|event` opens that panel a moment after launch.
      .task {
        guard let name = UserDefaults.standard.string(forKey: "QaliIsland") else { return }
        try? await Task.sleep(for: .seconds(1.5))
        switch name {
        case "account": island.open(.account)
        case "search": island.open(.search)
        // `-QaliBookingScreen main|requests` picks the booking face's screen.
        case "booking": island.open(.booking)
        case "request":
          while data.booking.pending.isEmpty { try? await Task.sleep(for: .milliseconds(100)) }
          let request = data.booking.pending[0]
          island.open(.bookingRequest(request))
          navigation.reveal(booking: request)
        case "paint":
          while data.booking.page == nil { try? await Task.sleep(for: .milliseconds(100)) }
          await data.booking.beginPainting(zone: navigation.zone)
        case "event":
          // `-QaliEventTitle Lunch` picks the first event with that title.
          while data.isLoadingEvents { try? await Task.sleep(for: .milliseconds(100)) }
          let title = UserDefaults.standard.string(forKey: "QaliEventTitle")
          if let event = data.events.first(where: { title == nil ? !$0.allDay : $0.title == title }) { island.open(.event(event)) }
        case "create":
          // Seed from loaded events, as a real click would be.
          while data.isLoadingEvents { try? await Task.sleep(for: .milliseconds(100)) }
          openCreate()
          // `-QaliAllDay YES` turns the new event's All day switch on.
          if UserDefaults.standard.bool(forKey: "QaliAllDay") { island.draft?.allDay = true }
          // `-QaliMeet YES` switches its Where row to a Google Meet.
          if UserDefaults.standard.bool(forKey: "QaliMeet") { island.draft?.meet = true }
        case "edit":
          // `-QaliEventTitle Lunch` picks the event, as for `event`.
          while data.isLoadingEvents { try? await Task.sleep(for: .milliseconds(100)) }
          let title = UserDefaults.standard.string(forKey: "QaliEventTitle")
          if let event = data.events.first(where: { title == nil ? !$0.allDay : $0.title == title }) {
            island.openEdit(event, draft: EventDraft.editing(event, zone: navigation.zone))
          }
        default: break
        }
      }
    #endif
  }

  /// The current face. Each one measures itself, and the shell follows.
  @ViewBuilder private var content: some View {
    if painting {
      AvailabilityPaintBar(ready: data.booking.paintingReady(zone: navigation.zone)) {
        data.booking.stopPainting()
      }
      .padding(.leading, 14)
      .padding(.trailing, 7)
      .padding(.vertical, 6)
      .fixedSize()
      .modifier(IslandFace(size: $size))
    } else {
      face
    }
  }

  @ViewBuilder private var face: some View {
    switch island.view {
    case nil:
      IslandNavRow(island: island, data: data, create: openCreate)
        .padding(.horizontal, 7)
        .padding(.vertical, 6)
        .fixedSize()
        .modifier(IslandFace(size: $size))
    case .account:
      AccountPanel(island: island)
        .modifier(IslandPanel(width: IslandView.account.width, size: $size))
    case .search:
      SearchPanel(island: island, data: data, navigation: navigation)
        .modifier(IslandPanel(width: IslandView.search.width, size: $size))
    case .event(let event):
      EventDetailPanel(event: event, island: island, data: data, navigation: navigation)
        .modifier(IslandPanel(width: IslandView.search.width, size: $size))
        // One event to the next is a swap too, not an update in place.
        .id(event.id)
    case .create:
      EventFormPanel(draft: draftBinding, island: island, data: data, navigation: navigation)
        .modifier(IslandPanel(width: IslandView.create.width, size: $size))
    case .edit(let event):
      EventFormPanel(draft: draftBinding, mode: .edit(event), island: island, data: data, navigation: navigation)
        .modifier(IslandPanel(width: IslandView.edit(event).width, size: $size))
        .id(event.id)
    case .booking:
      BookingPanel(island: island, data: data, navigation: navigation)
        .modifier(IslandPanel(width: IslandView.booking.width, size: $size))
    case .bookingRequest(let booking):
      BookingRequestPanel(booking: booking, island: island, data: data, navigation: navigation)
        .modifier(IslandPanel(width: IslandView.bookingRequest(booking).width, size: $size))
        .id(booking.id)
    }
  }

  private var draftBinding: Binding<EventDraft> {
    Binding(
      get: { island.draft ?? EventDraft(startMs: 0, endMs: 0) },
      set: { island.draft = $0 }
    )
  }

  /// Create from the dock or ⌘N (the web's `openCreate`): the next free
  /// half hour on today when the page shows it, else on the page's first day.
  private func openCreate() {
    let zone = navigation.zone
    let days = navigation.view == .month ? navigation.days : navigation.stripDays
    let today = zone.startOfDay(.now)
    let day = days.contains(where: navigation.isToday) ? today : zone.startOfDay(navigation.anchor)
    let dayStart = day.ms
    let dayEnd = zone.addingDays(1, to: day).ms
    let onDay = data.events.filter { $0.startMs < dayEnd && $0.endMs > dayStart }
    let slot = nextFreeSlot(dayStartMs: dayStart, events: onDay, nowMs: Date.now.ms)
    island.openCreate(startMs: slot.startMs, endMs: slot.endMs)
  }

  /// Escape closes a panel (an edit goes back to its event), ⌘K toggles
  /// search and ⌘N starts an event, from anywhere in the window. Over the
  /// create or edit form ⌘K stays quiet: only Escape or Cancel may throw a
  /// draft away.
  private var shortcuts: some View {
    Group {
      Button("Search") { island.toggle(.search) }
        .keyboardShortcut("k", modifiers: .command)
        .disabled(island.view?.holdsDraft == true || painting)
      Button("New Event", action: openCreate)
        .keyboardShortcut("n", modifiers: .command)
        .disabled(island.view?.holdsDraft == true || painting)
      // While painting, the bar's Done button owns Escape.
      if island.view != nil, !painting, !island.guestMatchesOpen, !island.drillDownOpen {
        Button("Close", action: island.cancel)
          .keyboardShortcut(.cancelAction)
      }
    }
    .opacity(0)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// A face of the island: it reports its size for the shell to take, and swaps
/// with the previous face the way the web's dock content does (a short fade,
/// a small rise and a touch of blur) while the shell resizes around it.
private struct IslandFace: ViewModifier {
  @Binding var size: CGSize

  func body(content: Content) -> some View {
    content
      .onGeometryChange(for: CGSize.self) { $0.size } action: { next in
        // The first measurement places the shell; later ones move it.
        if size == .zero {
          size = next
        } else {
          withAnimation(Island.spring) { size = next }
        }
      }
      .transition(
        .asymmetric(
          insertion: .modifier(active: FaceSwap(offset: 8), identity: FaceSwap(offset: 0))
            .animation(.easeOut(duration: 0.24)),
          removal: .modifier(active: FaceSwap(offset: -8), identity: FaceSwap(offset: 0))
            .animation(.easeOut(duration: 0.16))
        )
      )
  }
}

/// A panel face: fixed width, as tall as its content, with the shared inset.
private struct IslandPanel: ViewModifier {
  let width: CGFloat
  @Binding var size: CGSize

  func body(content: Content) -> some View {
    content
      .padding(16)
      .frame(width: width)
      .fixedSize(horizontal: false, vertical: true)
      .modifier(IslandFace(size: $size))
  }
}

private struct FaceSwap: ViewModifier {
  /// 0 at rest; the distance travelled while entering or leaving.
  let offset: CGFloat

  func body(content: Content) -> some View {
    content
      .opacity(offset == 0 ? 1 : 0)
      .blur(radius: offset == 0 ? 0 : 4)
      .offset(y: offset)
  }
}

/// Closes the island on a click outside it in the main window, without
/// swallowing the click: it still reaches whatever it was aimed at. The close
/// waits for the button to come back up and for that click to be handled, so
/// a click on another event hands the island straight over to it instead of
/// flashing the nav row in between. Clicks in the toolbar and in other windows
/// (popovers, menus) are left alone; paging the calendar keeps a panel open.
@MainActor
private final class OutsideClickMonitor {
  /// The island's frame, in the content view's top-left coordinates.
  var exempt: CGRect = .zero
  /// The island to close; nil while it is at rest.
  var island: Island? {
    didSet { island == nil ? stop() : start() }
  }

  private var monitor: Any?
  /// `island.changes` when an outside press went down.
  private var pressedAt: Int?

  private func start() {
    guard monitor == nil else { return }
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { [weak self] event in
      self?.handle(event)
      return event
    }
  }

  private func stop() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
    pressedAt = nil
  }

  private func handle(_ event: NSEvent) {
    guard let island else { return }
    if event.type == .leftMouseUp {
      guard let pressedAt else { return }
      self.pressedAt = nil
      // After the click itself has run: if it opened something, leave that be.
      DispatchQueue.main.async {
        if island.changes == pressedAt { island.close() }
      }
      return
    }
    guard
      let window = event.window,
      window.styleMask.contains(.titled),
      let content = window.contentView
    else { return }
    let location = event.locationInWindow
    // Above the content's layout area is the titlebar and toolbar.
    guard location.y <= window.contentLayoutRect.maxY else { return }
    let point = CGPoint(x: location.x, y: content.bounds.height - location.y)
    if !exempt.contains(point) { pressedAt = island.changes }
  }
}
