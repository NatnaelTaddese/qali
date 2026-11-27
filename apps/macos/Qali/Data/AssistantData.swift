import ConvexMobile
import Foundation
import Observation

extension ConvexAPI {
  static let assistantAvailable = "domains/assistant/data:isAvailable"
  static let assistantQuota = "domains/assistant/data:monthlyQuota"
  static let assistantThreads = "domains/assistant/data:listThreads"
  static let assistantMessages = "domains/assistant/data:listMessages"
  static let assistantActions = "domains/assistant/data:listPendingActions"
  static let assistantSend = "domains/assistant/loop:sendMessage"
  static let assistantConfirm = "domains/assistant/loop:confirmAction"
  static let assistantDeleteThread = "domains/assistant/maintenance:deleteThread"
}

/// A message on its way: drawn at the foot of the conversation the moment
/// it is sent, until the subscription delivers the stored row for it.
struct AssistantPendingSend: Equatable {
  /// The row's identity in the transcript, kept by the stored message once
  /// it arrives so the bubble doesn't re-enter.
  var key: String
  var text: String
  /// The newest user row before this send, so an identical earlier message
  /// is never mistaken for this one.
  var previousUserMessageId: String?
  var sentAt: Date
  /// Why it never reached the server ("Not Delivered"), once it failed.
  var failure: String?
}

/// The assistant's conversations for the signed-in user (the web's
/// `AssistantDock` state): the thread list, the open thread's turns and
/// proposals, the monthly allowance, and sending. Created with the session
/// and kept for it, so the pane opens onto a warm conversation.
@Observable
final class AssistantData {
  @ObservationIgnored let client: ConvexClient
  private let availableQuery: LiveQuery<Bool>
  private let quotaQuery: LiveQuery<AssistantQuota>
  private let threadsQuery: LiveQuery<[AssistantThread]>
  private let messagesQuery: LiveQuery<[AssistantMessage]>
  private let actionsQuery: LiveQuery<[AssistantAction]>

  /// The conversation on show; nil for a new one (or before the latest has
  /// been picked).
  private(set) var threadId: String?
  /// "New chat" was chosen: stay on the empty conversation rather than
  /// reopening the latest thread.
  private(set) var startFresh = false
  private(set) var pending: AssistantPendingSend?
  /// The send action is in flight (it runs the whole turn).
  private(set) var sending = false
  /// What's typed in the composer, kept while the pane is closed.
  var draft = ""
  /// The composer has the keyboard: the calendar's bare-key shortcuts must
  /// leave the typing alone.
  var composerFocused = false
  /// Auto mode: Qali makes changes to the user's own calendar without a
  /// confirm click (the backend decides which ones may). Follows the stored
  /// preference, and moves at once when switched here.
  private(set) var autoMode = false
  /// A switch the server hasn't echoed back yet, so a stale result doesn't
  /// flip the toggle back mid-save.
  @ObservationIgnored private var autoModeSaving = false
  /// Writes a preferences patch; set by CalendarData.
  @ObservationIgnored var savePreferences: ((PreferencesPatch) async throws -> Void)?
  /// The panel is out. While it isn't, a reply that finishes marks the
  /// conversation unread; opening it clears that.
  var isPanelOpen = false {
    didSet { if isPanelOpen, unread { unread = false } }
  }
  /// A reply finished while the panel was closed: the corner ghost wears a
  /// dot, as Messages marks a conversation with something new in it.
  private(set) var unread = false
  /// Replies seen while they were still being written, so only one that
  /// finishes now (not one that loads already finished) counts as new.
  @ObservationIgnored private var streamingSeen: Set<String> = []
  /// Stored rows drawn under a pending send's key, so the bubble that flew
  /// in keeps its identity once the real row replaces it.
  @ObservationIgnored private(set) var rowKeys: [String: String] = [:]
  /// The latest thread when a fresh send began, so the new thread it creates
  /// can be told apart from it.
  @ObservationIgnored private var previousLatestThreadId: String?
  @ObservationIgnored private var pendingCounter = 0

  #if DEBUG
    /// `-QaliFixture assistant`: a canned conversation and a local stand-in
    /// for the model, so the pane can be worked on without spending the
    /// monthly allowance.
    @ObservationIgnored let fixture = AssistantFixture.make()
  #endif

  init(client: ConvexClient) {
    self.client = client
    availableQuery = LiveQuery(client, ConvexAPI.assistantAvailable)
    quotaQuery = LiveQuery(client, ConvexAPI.assistantQuota, args: nil)
    threadsQuery = LiveQuery(client, ConvexAPI.assistantThreads, args: nil)
    messagesQuery = LiveQuery(client, ConvexAPI.assistantMessages, args: nil)
    actionsQuery = LiveQuery(client, ConvexAPI.assistantActions, args: nil)
    #if DEBUG
      if let fixture {
        if fixture.startsEmpty { startFresh = true } else { threadId = fixture.threads.first?.id }
        // `-QaliAssistantAuto YES` starts the fixture in auto mode.
        autoMode = UserDefaults.standard.bool(forKey: "QaliAssistantAuto")
        return
      }
    #endif
    availableQuery.onChange = { [weak self] in self?.availabilityChanged() }
    threadsQuery.onChange = { [weak self] in self?.adoptThread() }
    messagesQuery.onChange = { [weak self] in self?.messagesChanged() }
  }

  // MARK: - State

  /// Whether this deployment has an assistant at all; false until known, so
  /// nothing pops in a beat after launch.
  var isAvailable: Bool {
    #if DEBUG
      if fixture != nil { return true }
    #endif
    return availableQuery.value == true
  }

  var threads: [AssistantThread]? {
    #if DEBUG
      if let fixture { return fixture.threads }
    #endif
    return threadsQuery.value
  }

  /// The open thread's turns, oldest first; nil while they load. Another
  /// thread's turns are never shown in the meantime.
  var messages: [AssistantMessage]? {
    #if DEBUG
      if let fixture { return threadId == nil ? nil : fixture.messages }
    #endif
    guard threadId != nil, !messagesQuery.isLoading else { return nil }
    return messagesQuery.value
  }

  /// Every proposal in the open thread, by id, in any state.
  var actions: [String: AssistantAction] {
    #if DEBUG
      if let fixture { return Dictionary(uniqueKeysWithValues: fixture.actions.map { ($0.id, $0) }) }
    #endif
    guard threadId != nil, !actionsQuery.isLoading else { return [:] }
    return Dictionary((actionsQuery.value ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
  }

  var quota: AssistantQuota? {
    #if DEBUG
      if let fixture { return fixture.quota }
    #endif
    return quotaQuery.value
  }

  /// The allowance is spent (the backend enforces it too). Unknown counts as
  /// not spent, so the composer never flickers disabled.
  var limitReached: Bool { (quota?.remaining ?? 1) <= 0 }

  /// The model is still writing the open thread's latest turn.
  var turnInProgress: Bool { messages?.contains { $0.status == .streaming } ?? false }

  /// The open thread is being picked or loaded.
  var loadingConversation: Bool {
    guard pending == nil, !startFresh else { return false }
    if threadId == nil { return threads == nil || !(threads?.isEmpty ?? true) }
    return messages == nil
  }

  /// A send can't start: one is on its way, a reply is being written, or the
  /// conversation is still loading.
  var busy: Bool { sending || turnInProgress || loadingConversation }

  var canSend: Bool {
    !busy && !limitReached && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// Nothing to show yet: a new conversation with nothing sent.
  var isEmpty: Bool {
    pending == nil && threadId == nil && (startFresh || threads?.isEmpty == true)
  }

  /// The stored row that a pending send became, once it has arrived.
  var acknowledgedPendingId: String? {
    guard let pending, let messages else { return nil }
    guard let lastUser = messages.last(where: { $0.role == .user }) else { return nil }
    return lastUser.id != pending.previousUserMessageId && lastUser.text == pending.text ? lastUser.id : nil
  }

  /// A row's identity in the transcript.
  func rowKey(_ message: AssistantMessage) -> String { rowKeys[message.id] ?? message.id }

  // MARK: - Actions

  /// Starts (or resumes) the subscriptions; called when the pane appears.
  func activate() {
    refreshQuotaClock()
  }

  /// The quota's window rolls over on the server's clock; the query takes
  /// the time from the client so it can stay a pure query.
  func refreshQuotaClock() {
    guard isAvailable else { return }
    let now = (Date.now.timeIntervalSince1970 * 1000 / 60_000).rounded(.down) * 60_000
    quotaQuery.setArgs(["nowMs": now])
  }

  func select(_ thread: AssistantThread) {
    guard !busy, thread.id != threadId else { return }
    startFresh = false
    pending = nil
    setThread(thread.id)
  }

  /// The stored preference, as it arrives.
  func syncAutoMode(_ on: Bool) {
    #if DEBUG
      if fixture != nil { return }
    #endif
    guard !autoModeSaving, autoMode != on else { return }
    autoMode = on
  }

  /// Switches auto mode, optimistically; throws (and switches back) when it
  /// couldn't be saved.
  func setAutoMode(_ on: Bool) async throws {
    guard on != autoMode else { return }
    autoMode = on
    #if DEBUG
      if fixture != nil { return }
    #endif
    autoModeSaving = true
    defer { autoModeSaving = false }
    do {
      try await savePreferences?(PreferencesPatch(assistantAutoApply: on))
    } catch {
      autoMode = !on
      throw error
    }
  }

  /// Deletes the conversation on show, with its messages and any unconfirmed
  /// proposals, and starts an empty one. Throws with a reason to show.
  func deleteCurrent() async throws {
    guard !busy, let id = threadId else { return }
    #if DEBUG
      if let fixture {
        fixture.threads.removeAll { $0.id == id }
        fixture.messages = []
        leaveDeleted()
        return
      }
    #endif
    try await Self.deleteThread(client, id: id)
    leaveDeleted()
  }

  /// After a delete: an empty conversation, not the next-latest thread.
  private func leaveDeleted() {
    startFresh = true
    pending = nil
    previousLatestThreadId = threads?.first?.id
    setThread(nil)
  }

  private nonisolated static func deleteThread(_ client: ConvexClient, id: String) async throws {
    let _: String? = try await client.mutation(ConvexAPI.assistantDeleteThread, with: ["threadId": id])
  }

  /// Starts an empty conversation; the next send creates its thread.
  func newChat() {
    guard !busy, threadId != nil || pending != nil else { return }
    startFresh = true
    pending = nil
    previousLatestThreadId = threads?.first?.id
    setThread(nil)
  }

  /// Sends the draft (or `text`, for a suggestion) as the next turn. The
  /// action runs the whole agent loop; the reply arrives through the
  /// messages subscription while it does.
  func send(_ text: String? = nil, timeZone: String) async {
    let trimmed = (text ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !busy, !limitReached else { return }
    pendingCounter += 1
    let next = AssistantPendingSend(
      key: "pending-\(pendingCounter)",
      text: trimmed,
      previousUserMessageId: messages?.last(where: { $0.role == .user })?.id,
      sentAt: .now
    )
    if text == nil || text == draft { draft = "" }
    pending = next
    sending = true
    if threadId == nil { previousLatestThreadId = threads?.first?.id }
    defer { sending = false }

    #if DEBUG
      if let fixture {
        await fixture.reply(to: trimmed, data: self, key: next.key)
        setThread(fixture.threads.first?.id)
        if pending?.key == next.key { pending = nil }
        return
      }
    #endif

    let threadId = threadId
    do {
      let result = try await Self.sendTurn(client, threadId: threadId, text: trimmed, timeZone: timeZone)
      if self.threadId != result.threadId { setThread(result.threadId) }
      startFresh = false
      // The stored row has usually arrived by now; if not, the bubble stays
      // until it does (see `messagesChanged`).
      if acknowledgedPendingId != nil { pending = nil }
    } catch {
      // A turn that started and then failed is already on the thread, with
      // its error under the reply; only a send that never landed stays here.
      if acknowledgedPendingId != nil {
        pending = nil
      } else {
        pending?.failure = Self.failureMessage(error)
      }
    }
    refreshQuotaClock()
  }

  /// Sends a message that didn't go through again.
  func retry(timeZone: String) async {
    guard let failed = pending, failed.failure != nil else { return }
    pending = nil
    await send(failed.text, timeZone: timeZone)
  }

  /// Confirms or discards a proposal. Throws with a reason to show.
  func decide(_ action: AssistantAction, confirm: Bool) async throws {
    #if DEBUG
      if let fixture { return await fixture.decide(action.id, confirm: confirm) }
    #endif
    let id = action.id
    let decision = confirm ? "confirm" : "discard"
    try await CalendarData.act(client, ConvexAPI.assistantConfirm) {
      ["actionId": id, "decision": decision]
    }
  }

  #if DEBUG
    /// The fixture's new thread, as a fresh send's would be adopted.
    func fixtureOpen(_ id: String) {
      startFresh = false
      setThread(id)
    }
  #endif

  // MARK: - Subscriptions

  private func setThread(_ id: String?) {
    guard id != threadId || id == nil else { return }
    if id != threadId {
      // Keys only outlive a pending send within its own thread.
      if threadId != nil { rowKeys = [:] }
      threadId = id
    }
    let args: [String: ConvexEncodable?]? = id.map { ["threadId": $0] }
    #if DEBUG
      if fixture != nil { return }
    #endif
    messagesQuery.setArgs(args)
    actionsQuery.setArgs(args)
  }

  private func availabilityChanged() {
    guard isAvailable else { return }
    threadsQuery.setArgs([:])
    refreshQuotaClock()
  }

  /// Picks the conversation to show as the thread list changes: the latest
  /// one on open, or the thread a fresh send just created.
  private func adoptThread() {
    guard threadId == nil, let latest = threads?.first else { return }
    if !startFresh {
      setThread(latest.id)
    } else if pending != nil, latest.id != previousLatestThreadId {
      setThread(latest.id)
    }
  }

  /// Hands a pending send's row keys to the stored rows that answer it: its
  /// bubble to the user's row, and the typing dots to the reply's row, so
  /// neither re-enters when the subscription catches up.
  func messagesChanged() {
    noteFinishedReplies()
    guard let pending, let id = acknowledgedPendingId, let messages else { return }
    rowKeys[id] = pending.key
    if let index = messages.firstIndex(where: { $0.id == id }), index + 1 < messages.count,
      messages[index + 1].role == .assistant
    {
      rowKeys[messages[index + 1].id] = pending.key + "-thinking"
    }
    if !sending { self.pending = nil }
  }

  /// Marks the conversation unread when a reply seen mid-stream has
  /// finished while the panel is closed.
  private func noteFinishedReplies() {
    guard let messages else { return }
    for message in messages where message.role == .assistant {
      if message.status == .streaming {
        streamingSeen.insert(message.id)
      } else if streamingSeen.remove(message.id) != nil, !isPanelOpen {
        unread = true
      }
    }
  }

  private nonisolated static func sendTurn(
    _ client: ConvexClient, threadId: String?, text: String, timeZone: String
  ) async throws -> AssistantSendResult {
    var args: [String: ConvexEncodable?] = ["text": text, "timeZone": timeZone]
    // `v.optional` takes a missing key, not null.
    if let threadId { args["threadId"] = threadId }
    return try await client.action(ConvexAPI.assistantSend, with: args)
  }

  /// The reason under a message that didn't go through.
  static func failureMessage(_ error: Error) -> String {
    if case ClientError.ConvexError(let data) = error {
      if data.contains("ASSISTANT_MONTHLY_LIMIT") { return "You've used this month's messages." }
      if data.contains("ASSISTANT_MESSAGE_TOO_LONG") { return "That message is too long." }
      if data.contains("ASSISTANT_RATE_LIMIT") { return "Too many messages at once. Try again in a moment." }
      if data.contains("ASSISTANT_BUSY") || data.contains("ASSISTANT_THREAD_BUSY") {
        return "Qali is still answering another message."
      }
      if data.contains("ASSISTANT_UNCONFIGURED") { return "The assistant isn't set up on this server." }
    }
    return bookingErrorMessage(error)
  }
}
