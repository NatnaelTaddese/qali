import QaliDomain
import SwiftUI

/// The assistant's floating panel: a card on the calendar's trailing edge,
/// under the toolbar, that slides in over the grid. Sliding a card moves
/// pixels; docking a column would re-lay the whole grid out every frame.
struct AssistantPanel: View {
  let data: CalendarData
  let navigation: CalendarNavigation
  let close: () -> Void

  /// Quick and settled: a panel, not a sheet.
  static let spring = Animation.spring(duration: 0.32, bounce: 0.1)
  static let width: CGFloat = 360
  /// The corner button's size and its inset from the window's corner, the
  /// island's own height and bottom inset, so the two sit level.
  static let buttonSize: CGFloat = 46
  static let cornerInset: CGFloat = 22

  var body: some View {
    // The island's own shell: a Liquid Glass card with the island panels'
    // corners, and no border or shadow of its own.
    let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
    AssistantPane(data: data, navigation: navigation, close: close)
      .clipShape(shape)
      .glassEffect(.regular, in: shape)
      .frame(width: Self.width)
      .padding(.top, 6)
      .padding(.trailing, 10)
      // Ends just above its corner button, which stays to close it.
      .padding(.bottom, Self.cornerInset + Self.buttonSize + 10)
  }
}

/// The assistant's toggle in the window's bottom-right corner: a glass disc
/// with Qali's ghost, outlined at rest and solid while the panel is out.
struct AssistantCornerButton: View {
  @Binding var isOpen: Bool

  var body: some View {
    Button {
      isOpen.toggle()
    } label: {
      MascotShape(outline: !isOpen)
        .fill(Palette.foreground)
        .frame(width: 21, height: 21)
        .frame(width: AssistantPanel.buttonSize, height: AssistantPanel.buttonSize)
        .contentShape(.circle)
    }
    .buttonStyle(.plain)
    .glassEffect(.regular.interactive(), in: .circle)
    .accessibilityLabel(isOpen ? "Hide assistant" : "Ask Qali")
    .help(isOpen ? "Hide the assistant (⌘J)" : "Ask Qali (⌘J)")
  }
}

/// The assistant as a Messages conversation: your messages in blue on the
/// right, Qali's in grey on the left, tails on the last bubble of each run,
/// time stamps between bursts, the typing dots while it works, and a glass
/// composer at the foot. Its own header holds the conversation tools.
struct AssistantPane: View {
  let data: CalendarData
  let navigation: CalendarNavigation
  let close: () -> Void

  @FocusState private var composerFocused: Bool
  @State private var position = ScrollPosition(edge: .bottom)
  /// The thread whose transcript animates its changes: set a beat after a
  /// thread loads, so opening one doesn't fly every bubble in.
  @State private var liveThread: String?
  /// More of the transcript above or below the view: its edge fades, as the
  /// island's own scrolling panels do.
  @State private var fade = (top: false, bottom: false)

  private var assistant: AssistantData { data.assistant }
  private var zoneId: String { navigation.zone.identifier }

  var body: some View {
    VStack(spacing: 0) {
      header
      Group {
        if assistant.isEmpty {
          EmptyConversation(assistant: assistant) { send($0) }
        } else {
          transcript
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      composer
    }
    .onExitCommand(perform: close)
    .onAppear {
      assistant.activate()
      composerFocused = true
    }
    .onChange(of: composerFocused) { _, focused in assistant.composerFocused = focused }
    .onDisappear { assistant.composerFocused = false }
    .task(id: assistant.threadId) {
      liveThread = nil
      // A new conversation has nothing to fly in but what's sent.
      guard let id = assistant.threadId else { return }
      while assistant.messages == nil { try? await Task.sleep(for: .milliseconds(50)) }
      try? await Task.sleep(for: .milliseconds(300))
      liveThread = id
    }
    #if DEBUG
      // `-QaliAssistantSend "text"` sends a message a moment after launch,
      // to watch a turn arrive without typing.
      .task {
        guard let text = UserDefaults.standard.string(forKey: "QaliAssistantSend") else { return }
        while !assistant.isAvailable || assistant.busy || assistant.threads == nil {
          try? await Task.sleep(for: .milliseconds(200))
        }
        try? await Task.sleep(for: .seconds(1))
        send(text)
      }
    #endif
  }

  // MARK: - Transcript

  private var animates: Bool { assistant.threadId == nil || liveThread == assistant.threadId }

  private var transcript: some View {
    let rows = TranscriptRow.build(assistant)
    return ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if assistant.loadingConversation {
          ProgressView()
            .controlSize(.small)
            .frame(maxWidth: .infinity)
            .padding(.top, 40)
        }
        ForEach(rows) { row in
          rowView(row)
            .padding(.top, row.gapAbove)
            .transition(row.transition)
        }
      }
      .padding(.horizontal, 12)
      .padding(.top, 8)
      .padding(.bottom, 10)
      .animation(animates ? .spring(duration: 0.35, bounce: 0.18) : nil, value: rows.map(\.signature))
    }
    .scrollPosition($position)
    .defaultScrollAnchor(.bottom)
    .mask { EdgeFade(top: fade.top, bottom: fade.bottom) }
    // Follow a reply as it streams, unless the user has scrolled up to read.
    .onScrollGeometryChange(for: ScrollGeometry.self) { $0 } action: { old, new in
      let grew = new.contentSize.height > old.contentSize.height + 0.5
      let wasAtBottom = old.visibleRect.maxY >= old.contentSize.height - 48
      if grew, wasAtBottom { position.scrollTo(edge: .bottom) }
      let next = (top: new.visibleRect.minY > 1, bottom: new.visibleRect.maxY < new.contentSize.height - 1)
      if next != fade { withAnimation(.easeOut(duration: 0.15)) { fade = next } }
    }
    .onChange(of: assistant.pending?.key) { _, key in
      guard key != nil else { return }
      withAnimation(.snappy(duration: 0.3)) { position.scrollTo(edge: .bottom) }
    }
  }

  @ViewBuilder private func rowView(_ row: TranscriptRow) -> some View {
    switch row.kind {
    case .stamp(let date):
      TimeStamp(date: date, zone: navigation.zone)
    case .user(let text, let state):
      SentMessage(text: text, state: state) {
        Task { await assistant.retry(timeZone: zoneId) }
      }
    case .turn(let message, let isLast):
      AssistantTurn(
        message: message, actions: assistant.actions, isLast: isLast, data: data, navigation: navigation
      ) { send($0) }
    case .thinking:
      HStack { TypingBubble(); Spacer(minLength: 0) }
    }
  }

  // MARK: - Composer

  private var composer: some View {
    @Bindable var assistant = assistant
    return VStack(spacing: 6) {
      if let quota = assistant.quota {
        if quota.remaining <= 0 {
          Text("You've used all \(Int(quota.limit)) messages this month.")
            .foregroundStyle(Palette.destructive)
        } else if quota.remaining <= 3 {
          Text(quota.remaining == 1 ? "1 message left this month" : "\(Int(quota.remaining)) messages left this month")
            .foregroundStyle(Palette.mutedForeground)
        }
      }

      HStack(alignment: .bottom, spacing: 4) {
        TextField(
          assistant.limitReached ? "Out of messages this month" : "Ask Qali", text: $assistant.draft, axis: .vertical
        )
        .textFieldStyle(.plain)
        .font(.sans(TextSize.sm))
        .lineLimit(1...8)
        .focused($composerFocused)
        .disabled(assistant.limitReached)
        .onSubmit { send(nil) }
        .padding(.leading, 13)
        .padding(.vertical, 7)
        .accessibilityLabel("Message Qali")

        if !assistant.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          Button { send(nil) } label: {
            Image(systemName: "arrow.up")
              .font(.system(size: 12, weight: .bold))
              .foregroundStyle(.white)
              .frame(width: 24, height: 24)
              .background(Circle().fill(assistant.canSend ? BubbleColors.sent : Palette.mutedForeground.opacity(0.5)))
          }
          .buttonStyle(.plain)
          .disabled(!assistant.canSend)
          .padding(4)
          .accessibilityLabel("Send")
          .help(assistant.busy ? "Qali is still answering" : "Send (Return)")
          .transition(.scale(scale: 0.4).combined(with: .opacity))
        }
      }
      .frame(minHeight: 32)
      .padding(.trailing, assistant.draft.isEmpty ? 10 : 0)
      .background(Palette.foreground.opacity(0.06), in: .rect(cornerRadius: 16, style: .continuous))
      .animation(.snappy(duration: 0.2), value: assistant.draft.isEmpty)
    }
    .font(.sans(TextSize.xs))
    .padding(.horizontal, 12)
    .padding(.top, 6)
    .padding(.bottom, 12)
  }

  private func send(_ text: String?) {
    guard text != nil || assistant.canSend else { return }
    Task { await assistant.send(text, timeZone: zoneId) }
  }

  // MARK: - Header

  /// Qali's name and the conversation on show, with the conversation tools:
  /// earlier conversations, a new one, and close.
  private var header: some View {
    HStack(spacing: 8) {
      AssistantAvatar(size: 30)
      VStack(alignment: .leading, spacing: 1) {
        Text("Qali")
          .font(.sans(TextSize.sm, .semibold))
          .foregroundStyle(Palette.foreground)
        Text(assistant.threads?.first { $0.id == assistant.threadId }?.title ?? "New conversation")
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      historyMenu
      HeaderDisc(symbol: "square.and.pencil", label: "New conversation") {
        assistant.newChat()
        composerFocused = true
      }
      .disabled(assistant.busy || assistant.isEmpty)
      IslandCloseButton(action: close)
    }
    .padding(.leading, 14)
    .padding(.trailing, 10)
    .padding(.vertical, 10)
  }

  private var historyMenu: some View {
    Menu {
      if let threads = assistant.threads, !threads.isEmpty {
        Picker(
          "Conversations",
          selection: Binding(
            get: { assistant.threadId ?? "" },
            set: { id in if let thread = threads.first(where: { $0.id == id }) { assistant.select(thread) } }
          )
        ) {
          ForEach(threads) { thread in
            Text(thread.title).tag(thread.id)
          }
        }
        .pickerStyle(.inline)
      } else {
        Text("No conversations yet")
      }
    } label: {
      HeaderDisc.icon("clock.arrow.circlepath")
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .fixedSize()
    .glassEffect(.regular.interactive(), in: .circle)
    .disabled(assistant.busy)
    .accessibilityLabel("Earlier conversations")
    .help("Earlier conversations")
  }
}

/// The transcript's edges fading out where there's more to scroll, so a
/// message slips under the header and composer instead of being cut.
private struct EdgeFade: View {
  var top: Bool
  var bottom: Bool
  private let length: CGFloat = 18

  var body: some View {
    VStack(spacing: 0) {
      LinearGradient(colors: [top ? .clear : .black, .black], startPoint: .top, endPoint: .bottom)
        .frame(height: length)
      Color.black
      LinearGradient(colors: [.black, bottom ? .clear : .black], startPoint: .top, endPoint: .bottom)
        .frame(height: length)
    }
  }
}

/// A round glass button in the panel's header, matching its close disc.
private struct HeaderDisc: View {
  let symbol: String
  let label: String
  let action: () -> Void
  @Environment(\.isEnabled) private var isEnabled

  static func icon(_ symbol: String) -> some View {
    Image(systemName: symbol)
      .font(.system(size: 13, weight: .medium))
      .foregroundStyle(Palette.foreground)
      .frame(width: 30, height: 30)
      .contentShape(.circle)
  }

  var body: some View {
    Button(action: action) { Self.icon(symbol).opacity(isEnabled ? 1 : 0.4) }
      .buttonStyle(.plain)
      .glassEffect(.regular.interactive(), in: .circle)
      .accessibilityLabel(label)
      .help(label)
  }
}

// MARK: - Rows

/// One row of the transcript, with its spacing and how it arrives.
struct TranscriptRow: Identifiable {
  enum SendState: Equatable {
    case sent, sending
    case failed(String)
  }

  enum Kind {
    case stamp(Date)
    case user(String, SendState)
    case turn(AssistantMessage, isLast: Bool)
    /// Sent, and nothing from the server yet.
    case thinking
  }

  var id: String
  var kind: Kind
  var gapAbove: CGFloat

  /// What the transcript animates on: rows coming and going, and a reply
  /// growing as it streams.
  var signature: String {
    switch kind {
    case .turn(let message, _): "\(id):\(message.blocks.count):\(message.text.count):\(message.status.rawValue)"
    case .user(_, let state): "\(id):\(state)"
    default: id
    }
  }

  var transition: AnyTransition {
    switch kind {
    // A sent message rises out of the composer, as in Messages.
    case .user:
      .asymmetric(
        insertion: .scale(scale: 0.7, anchor: .bottomTrailing).combined(with: .offset(y: 30)).combined(with: .opacity),
        removal: .opacity)
    case .turn, .thinking:
      .asymmetric(insertion: .scale(scale: 0.85, anchor: .bottomLeading).combined(with: .opacity), removal: .opacity)
    case .stamp:
      .opacity
    }
  }

  /// A quarter of an hour apart starts a new burst, with its own stamp.
  private static let burstGap: Double = 15 * 60_000

  static func build(_ assistant: AssistantData) -> [TranscriptRow] {
    var rows: [TranscriptRow] = []
    var lastMs: Double?
    var lastRole: AssistantMessage.Role?

    func stamp(_ ms: Double) {
      if let lastMs, ms - lastMs < burstGap { return }
      rows.append(TranscriptRow(id: "stamp-\(Int(ms))", kind: .stamp(Date(ms: ms)), gapAbove: rows.isEmpty ? 0 : 14))
      lastRole = nil
    }
    func gap(_ role: AssistantMessage.Role) -> CGFloat {
      defer { lastRole = role }
      guard let lastRole else { return 6 }
      return lastRole == role ? 3 : 10
    }

    let messages = assistant.messages ?? []
    let acknowledged = assistant.acknowledgedPendingId
    for (index, message) in messages.enumerated() {
      stamp(message.createdAt)
      lastMs = message.createdAt
      let key = assistant.rowKey(message)
      if message.role == .user {
        let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { continue }
        // Stored means the server has it: delivered.
        rows.append(TranscriptRow(id: key, kind: .user(message.text, .sent), gapAbove: gap(.user)))
      } else {
        rows.append(
          TranscriptRow(
            id: key, kind: .turn(message, isLast: index == messages.count - 1 && assistant.pending == nil),
            gapAbove: gap(.assistant)))
      }
    }

    if let pending = assistant.pending, acknowledged == nil {
      let ms = pending.sentAt.timeIntervalSince1970 * 1000
      stamp(ms)
      lastMs = ms
      let state: SendState = pending.failure.map(SendState.failed) ?? .sending
      rows.append(TranscriptRow(id: pending.key, kind: .user(pending.text, state), gapAbove: gap(.user)))
      if pending.failure == nil {
        rows.append(TranscriptRow(id: pending.key + "-thinking", kind: .thinking, gapAbove: gap(.assistant)))
      }
    }
    return rows
  }
}

/// "Today 9:41 AM", centred between bursts, as Messages stamps them.
private struct TimeStamp: View {
  let date: Date
  let zone: WorkingZone

  var body: some View {
    let (day, time) = Self.parts(date, zone: zone)
    Text("\(Text(day).font(.sans(TextSize.xs, .semibold))) \(Text(time).font(.sans(TextSize.xs)))")
      .foregroundStyle(Palette.mutedForeground)
      .frame(maxWidth: .infinity)
      .padding(.bottom, 2)
  }

  static func parts(_ date: Date, zone: WorkingZone) -> (String, String) {
    let calendar = zone.calendar
    let time = zone.format(date, "h:mm a")
    let today = calendar.startOfDay(for: .now)
    let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: today).day ?? 0
    switch days {
    case 0: return ("Today", time)
    case 1: return ("Yesterday", time)
    case 2..<7: return (zone.format(date, "EEEE"), time)
    default:
      let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: .now)
      return (zone.format(date, sameYear ? "EEE, MMM d" : "MMM d, yyyy"), "at " + time)
    }
  }
}

/// One of the user's messages: a blue bubble on the right, dimmed while it
/// is on its way, with Messages' red mark and "Not Delivered" if it failed.
private struct SentMessage: View {
  let text: String
  let state: TranscriptRow.SendState
  let retry: () -> Void

  var body: some View {
    HStack(alignment: .center, spacing: 6) {
      Spacer(minLength: 44)
      VStack(alignment: .trailing, spacing: 3) {
        MessageBubble(trailing: true, tail: true, dimmed: state == .sending) {
          Text(text).fixedSize(horizontal: false, vertical: true)
        }
        if case .failed(let reason) = state {
          HStack(spacing: 4) {
            Text("Not Delivered").fontWeight(.medium).foregroundStyle(Palette.destructive)
            Text("·").foregroundStyle(Palette.mutedForeground)
            Button("Try Again", action: retry)
              .buttonStyle(.plain)
              .foregroundStyle(BubbleColors.sent)
          }
          .font(.sans(TextSize.xs))
          Text(reason)
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
            .multilineTextAlignment(.trailing)
        }
      }
      if case .failed = state {
        Image(systemName: "exclamationmark.circle.fill")
          .font(.system(size: 17))
          .foregroundStyle(.white, Palette.destructive)
          .accessibilityLabel("Not delivered")
      }
    }
  }
}

// MARK: - A turn

/// What each tool did, in the user's terms: while it runs, and once done.
private let toolLabels: [String: (running: String, done: String)] = [
  "list_events": ("Checking your calendar", "Checked your calendar"),
  "find_free_time": ("Looking for open time", "Looked for open time"),
  "search_contacts": ("Looking up contacts", "Looked up contacts"),
  "get_availability_settings": ("Reading your booking settings", "Read your booking settings"),
  "list_pending_booking_requests": ("Checking booking requests", "Checked booking requests"),
  "create_event": ("Drafting an event", "Drafted an event"),
  "update_event": ("Drafting a change", "Drafted a change"),
  "move_event": ("Drafting a reschedule", "Drafted a reschedule"),
  "delete_event": ("Drafting a cancellation", "Drafted a cancellation"),
  "decide_booking_request": ("Drafting a reply", "Drafted a reply"),
]

/// One of Qali's turns. Its prose becomes grey bubbles (the last with the
/// tail), its proposals confirm cards; what it looked up is a quiet line
/// above, raw tool results stay hidden (they're written for the model), and
/// while it works the typing dots say what it's doing.
private struct AssistantTurn: View {
  let message: AssistantMessage
  let actions: [String: AssistantAction]
  let isLast: Bool
  let data: CalendarData
  let navigation: CalendarNavigation
  let send: (String) -> Void

  private enum Item: Identifiable {
    case text(Int, String)
    case proposal(Int, AssistantAction)
    var id: Int {
      switch self {
      case .text(let index, _), .proposal(let index, _): index
      }
    }
  }

  var body: some View {
    let streaming = message.status == .streaming
    let items = items
    let active = activeTool
    let typing = streaming && (items.isEmpty || active != nil)
    VStack(alignment: .leading, spacing: 3) {
      if !steps.isEmpty, !(typing && items.isEmpty) {
        stepsLine
      }
      ForEach(items) { item in
        switch item {
        case .text(let index, let text):
          HStack(spacing: 0) {
            MessageBubble(trailing: false, tail: !typing && index == items.last?.id) {
              AssistantMarkdown(text: text)
            }
            Spacer(minLength: 36)
          }
        case .proposal(_, let action):
          ProposalCard(action: action, data: data, navigation: navigation)
            .frame(maxWidth: 330, alignment: .leading)
            .padding(.vertical, 2)
        }
      }
      if typing {
        TypingBubble()
        if let active {
          Text((toolLabels[active]?.running ?? "Working") + "…")
            .font(.sans(TextSize.xs))
            .foregroundStyle(Palette.mutedForeground)
            .padding(.leading, BubbleShape.tailWidth + 4)
            .transition(.opacity)
        }
      }
      if message.status == .error {
        Label(message.error ?? "Something went wrong.", systemImage: "exclamationmark.circle.fill")
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.destructive)
          .padding(.leading, BubbleShape.tailWidth + 4)
          .padding(.top, 2)
      }
      if isLast, message.status == .complete, let suggestions = message.suggestions, !suggestions.isEmpty {
        SuggestionBubbles(suggestions: suggestions, disabled: data.assistant.busy || data.assistant.limitReached, send: send)
          .padding(.top, 8)
      }
    }
  }

  private var items: [Item] {
    message.blocks.enumerated().compactMap { index, block in
      switch block {
      case .text(let text):
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : .text(index, trimmed)
      case .proposal(_, let actionId):
        return actions[actionId].map { .proposal(index, $0) }
      default:
        return nil
      }
    }
  }

  private var results: [String: Bool] {
    var out: [String: Bool] = [:]
    for case .toolResult(let id, let isError) in message.blocks { out[id] = isError }
    return out
  }

  /// The call still waiting on its result, while the turn streams.
  private var activeTool: String? {
    guard message.status == .streaming else { return nil }
    let results = results
    for case .toolCall(let id, let name) in message.blocks.reversed() where results[id] == nil {
      return name
    }
    return nil
  }

  /// What was looked up and drafted, in order, without repeats in a row.
  private var steps: [(label: String, failed: Bool)] {
    let results = results
    var out: [(String, Bool)] = []
    for case .toolCall(let id, let name) in message.blocks {
      guard let failed = results[id] else { continue }
      let label = toolLabels[name]?.done ?? "Worked"
      if out.last?.0 != label { out.append((label, failed)) }
    }
    return out
  }

  private var stepsLine: some View {
    steps.enumerated().reduce(Text("")) { line, step in
      let piece = Text(step.element.label).foregroundStyle(step.element.failed ? Palette.destructive : Palette.mutedForeground)
      return step.offset == 0 ? piece : Text("\(line)  ·  \(piece)")
    }
    .foregroundStyle(Palette.mutedForeground)
    .font(.sans(TextSize.xs))
    .padding(.leading, BubbleShape.tailWidth + 4)
    .padding(.bottom, 2)
  }
}

/// Things you might say next, as outlined bubbles on your side: a click
/// sends one.
private struct SuggestionBubbles: View {
  let suggestions: [String]
  var disabled = false
  let send: (String) -> Void

  var body: some View {
    VStack(alignment: .trailing, spacing: 5) {
      ForEach(suggestions, id: \.self) { suggestion in
        Button { send(suggestion) } label: {
          Text(suggestion)
            .font(.sans(TextSize.sm))
            .multilineTextAlignment(.trailing)
            .foregroundStyle(BubbleColors.sent)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .overlay {
              RoundedRectangle(cornerRadius: BubbleShape.radius, style: .continuous)
                .strokeBorder(BubbleColors.sent.opacity(0.55), lineWidth: 1)
            }
            .contentShape(.rect(cornerRadius: BubbleShape.radius))
        }
        .buttonStyle(SuggestionButtonStyle())
        .padding(.trailing, BubbleShape.tailWidth)
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, 40)
    .disabled(disabled)
    .opacity(disabled ? 0.5 : 1)
  }
}

private struct SuggestionButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    Hover(configuration: configuration)
  }

  private struct Hover: View {
    let configuration: Configuration
    @State private var hovering = false

    var body: some View {
      configuration.label
        .background {
          RoundedRectangle(cornerRadius: BubbleShape.radius, style: .continuous)
            .fill(BubbleColors.sent.opacity(configuration.isPressed ? 0.18 : hovering ? 0.08 : 0))
        }
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
  }
}

/// A new conversation: Qali's contact card in the middle, and a few ways to
/// start on your side, above the composer.
private struct EmptyConversation: View {
  let assistant: AssistantData
  let send: (String) -> Void

  static let starters = [
    "What's on my calendar tomorrow?",
    "Find 30 minutes for a call this week",
    "Move my next meeting an hour later",
  ]

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 24)
      VStack(spacing: 8) {
        AssistantAvatar(size: 64)
        Text("Qali")
          .font(.display(TextSize.xl2))
          .foregroundStyle(Palette.foreground)
        Text("Ask about your calendar. Qali checks with you before it changes anything.")
          .font(.sans(TextSize.xs))
          .foregroundStyle(Palette.mutedForeground)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 240)
      }
      Spacer(minLength: 24)
      SuggestionBubbles(suggestions: Self.starters, disabled: assistant.busy || assistant.limitReached, send: send)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }
  }
}
