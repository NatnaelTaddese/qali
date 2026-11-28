import QaliDomain
import SwiftUI

/// The gate between the assistant and the calendar (the web's
/// `AssistantProposalCard`), drawn like one of Messages' rich cards: every
/// write the assistant wants to make stops here until Confirm is pressed.
/// The sentence is the server's own preview, so the button and what it
/// approves can't drift apart, and the card is drawn from the live row, so
/// after a decision it becomes the record of it.
struct ProposalCard: View {
  let action: AssistantAction
  let data: CalendarData
  let navigation: CalendarNavigation

  /// The card's secondary text (the kind label, details, status lines). Not
  /// the theme's muted grey, which sank into the event tint behind it ("RESCHEDULE",
  /// "Event rescheduled." on a red card): the text colour at reduced strength
  /// keeps its contrast over any hue, in light and dark. 60%: 72% read as
  /// loud as the sentence it sits under.
  static let secondaryText = Palette.foreground.opacity(0.6)

  @State private var busy: Bool?
  @State private var showDetails = false
  @State private var error: String?

  /// The event it touches, when that is on the grid's window.
  private var target: CalendarEvent? {
    action.eventId.flatMap { id in data.events.first { $0.id == id } }
  }

  /// Tinted to the event it touches, so it reads as a preview of that card
  /// on the grid; a new event stays neutral.
  private var hue: Color {
    target.map { Palette.event(data.colorKey(for: $0)) } ?? Palette.eventNeutral
  }

  private var kind: (title: String, symbol: String) {
    switch action.tool {
    case "create_event": ("New event", "calendar.badge.plus")
    case "update_event": ("Change event", "pencil")
    case "move_event": ("Reschedule", "arrow.forward.circle")
    case "delete_event": ("Cancel event", "calendar.badge.minus")
    case "decide_booking_request": ("Booking request", "calendar.badge.clock")
    default: ("Change", "calendar")
    }
  }

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: BubbleShape.radius, style: .continuous)
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        Image(systemName: kind.symbol)
          .font(.system(size: 11, weight: .semibold))
        Text(kind.title.uppercased())
          .font(.sans(10, .semibold))
          .tracking(0.4)
      }
      .foregroundStyle(Self.secondaryText)
      .padding(.bottom, 5)

      Text(action.preview)
        .font(.sans(TextSize.sm))
        .foregroundStyle(Palette.foreground)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)

      if action.status == .pending, !action.details.isEmpty {
        details
      }

      footer
        .padding(.top, 10)
    }
    .padding(.leading, 16)
    .padding(.trailing, 12)
    .padding(.vertical, 10)
    .background {
      ZStack(alignment: .leading) {
        shape.fill(Palette.foreground.opacity(0.05))
        shape.fill(hue.opacity(0.2))
        Capsule().fill(hue).frame(width: 3).padding(.vertical, 9).padding(.leading, 6)
      }
    }
    .padding(.leading, BubbleShape.tailWidth)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Proposed calendar change")
    .onChange(of: action.status) { old, new in
      if new == .applied, old != .applied { reveal() }
    }
    // A change auto mode just made arrives already applied, with no
    // transition to catch: reach for it if it's fresh.
    .task(id: action.id) {
      if action.status == .applied, Date.now.timeIntervalSince1970 * 1000 - action.createdAt < 20_000 {
        reveal()
      }
    }
  }

  private var details: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(.snappy(duration: 0.25)) { showDetails.toggle() }
      } label: {
        HStack(spacing: 3) {
          Text("Details")
          Image(systemName: "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .rotationEffect(.degrees(showDetails ? 90 : 0))
        }
        .font(.sans(TextSize.xs, .medium))
        .foregroundStyle(Self.secondaryText)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      if showDetails {
        ForEach(action.details, id: \.label) { row in
          VStack(alignment: .leading, spacing: 1) {
            Text(row.label)
              .font(.sans(TextSize.xs, .medium))
              .foregroundStyle(Self.secondaryText)
            Text(row.value)
              .font(.sans(TextSize.xs))
              .foregroundStyle(Palette.foreground)
              .textSelection(.enabled)
              .fixedSize(horizontal: false, vertical: true)
          }
          .transition(.opacity)
        }
      }
    }
    .padding(.top, 8)
  }

  @ViewBuilder private var footer: some View {
    let applying = action.status == .applying || (action.status == .pending && busy != nil)
    if action.status == .pending, !applying {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          Spacer(minLength: 0)
          Button("Discard") { decide(confirm: false) }
            .buttonStyle(.glass)
          Button("Confirm") { decide(confirm: true) }
            // No Return shortcut: Return in the composer sends a message,
            // and must never approve a change on the way.
            .modifier(PrimaryButton())
        }
        .controlSize(.regular)
        .buttonBorderShape(.capsule)
        .font(.sans(TextSize.sm, .medium))
        if let error {
          status(error, symbol: "exclamationmark.triangle.fill", tint: Palette.destructive)
        }
      }
    } else if applying {
      HStack(spacing: 6) {
        ProgressView().controlSize(.mini)
        Text(busy == false ? "Discarding…" : "Making the change…")
      }
      .font(.sans(TextSize.xs))
      .foregroundStyle(Self.secondaryText)
    } else {
      switch action.status {
      case .applied:
        status(action.resultSummary ?? "Done.", symbol: "checkmark.circle.fill", tint: Self.secondaryText)
      case .rejected:
        status("Discarded.", symbol: "xmark.circle", tint: Self.secondaryText)
      case .failed:
        status(
          action.resultSummary ?? "That didn't work.", symbol: "exclamationmark.triangle.fill",
          tint: Palette.destructive)
      default:
        EmptyView()
      }
    }
  }

  private func status(_ text: String, symbol: String, tint: Color) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 5) {
      Image(systemName: symbol)
      Text(text).fixedSize(horizontal: false, vertical: true)
    }
    .font(.sans(TextSize.xs))
    .foregroundStyle(tint)
  }

  private func decide(confirm: Bool) {
    guard busy == nil else { return }
    busy = confirm
    error = nil
    Task {
      do {
        try await data.assistant.decide(action, confirm: confirm)
      } catch {
        self.error =
          (confirm ? "Couldn't make that change. " : "Couldn't discard that. ") + bookingErrorMessage(error)
      }
      busy = nil
    }
  }

  /// Reaches for what the change touched once it lands, at the proposal's
  /// own time: the event may still be syncing back from Google.
  private func reveal() {
    if let startMs = action.timedStartMs {
      navigation.reveal(id: action.eventId, atMs: startMs)
    } else if let target {
      navigation.reveal(target)
    }
  }
}
