import SwiftUI

/// Qali's contact card, opened from the name in the conversation header,
/// the way Messages opens a contact's details: the photo and name, a row of
/// actions, and what's worth knowing about this contact (it asks before it
/// changes anything, and how many messages are left this month).
struct AssistantContactCard: View {
  let assistant: AssistantData
  let newConversation: () -> Void
  let deleteConversation: () -> Void

  var body: some View {
    VStack(spacing: 14) {
      VStack(spacing: 8) {
        AssistantAvatar(size: 72)
        VStack(spacing: 2) {
          Text("Qali")
            .font(.display(TextSize.xl2))
            .foregroundStyle(Palette.foreground)
          // Straight on the glass: the system's vibrant secondary keeps
          // its contrast there, where the flat muted grey faded.
          Text("Your calendar assistant")
            .font(.sans(TextSize.xs, .medium))
            .foregroundStyle(.secondary)
        }
      }

      HStack(spacing: 8) {
        CardAction(symbol: "square.and.pencil", label: "New", action: newConversation)
          .disabled(assistant.busy || assistant.isEmpty)
        CardAction(symbol: "trash", label: "Delete", destructive: true, action: deleteConversation)
          .disabled(assistant.busy || assistant.threadId == nil)
      }

      VStack(alignment: .leading, spacing: 0) {
        CardRow(symbol: "checkmark.shield") {
          Text("Asks before it changes anything")
            .foregroundStyle(Palette.foreground)
          Text("Nothing reaches your calendar or anyone's inbox until you confirm.")
            .foregroundStyle(Palette.mutedForeground)
        }
        if let quota = assistant.quota {
          Divider().padding(.leading, 30)
          CardRow(symbol: "bubble.left.and.text.bubble.right") {
            HStack {
              Text("Messages this month")
                .foregroundStyle(Palette.foreground)
              Spacer(minLength: 8)
              Text("\(Int(quota.remaining)) of \(Int(quota.limit)) left")
                .monospacedDigit()
                .foregroundStyle(quota.remaining <= 0 ? Palette.destructive : Palette.mutedForeground)
            }
            QuotaBar(used: quota.used, limit: quota.limit)
              .padding(.top, 3)
          }
        }
        Divider().padding(.leading, 30)
        CardRow(symbol: "clock") {
          Text("Conversations are kept for 30 days")
            .foregroundStyle(Palette.mutedForeground)
        }
      }
      .font(.sans(TextSize.xs))
      .modifier(CardSurface())
    }
    .padding(16)
    .frame(width: 280)
  }
}

/// What the card's tiles and info box sit on: the popover stays clear glass,
/// but text gets a mostly solid backing, so the conversation's blue bubbles
/// behind it don't wash it out.
private struct CardSurface: ViewModifier {
  var highlight = 0.0

  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    content.background {
      ZStack {
        shape.fill(Palette.popover.opacity(0.82))
        shape.fill(Palette.foreground.opacity(0.04 + highlight))
      }
    }
  }
}

/// One of the card's action tiles, like Messages' call and mail buttons.
private struct CardAction: View {
  let symbol: String
  let label: String
  var destructive = false
  let action: () -> Void
  @Environment(\.isEnabled) private var isEnabled
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      VStack(spacing: 4) {
        Image(systemName: symbol)
          .font(.system(size: 15, weight: .medium))
        Text(label)
          .font(.sans(TextSize.xs, .medium))
      }
      .foregroundStyle(destructive ? Palette.destructive : BubbleColors.sent)
      .frame(maxWidth: .infinity)
      .frame(height: 52)
      .modifier(CardSurface(highlight: hovering ? 0.04 : 0))
      .contentShape(.rect(cornerRadius: 12))
      .opacity(isEnabled ? 1 : 0.4)
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 && isEnabled }
    .animation(.easeOut(duration: 0.12), value: hovering)
  }
}

/// A row of the card's details: a symbol, then the text.
private struct CardRow<Content: View>: View {
  let symbol: String
  @ViewBuilder var content: Content

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(Palette.mutedForeground)
        .frame(width: 14)
      VStack(alignment: .leading, spacing: 2) { content }
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// The month's allowance used, as a thin capsule.
private struct QuotaBar: View {
  let used: Double
  let limit: Double

  var body: some View {
    let fraction = limit > 0 ? min(max(used / limit, 0), 1) : 0
    Capsule()
      .fill(Palette.foreground.opacity(0.1))
      .frame(height: 4)
      .overlay(alignment: .leading) {
        GeometryReader { proxy in
          Capsule()
            .fill(fraction >= 1 ? Palette.destructive : BubbleColors.sent)
            .frame(width: proxy.size.width * fraction)
        }
      }
      .accessibilityHidden(true)
  }
}
