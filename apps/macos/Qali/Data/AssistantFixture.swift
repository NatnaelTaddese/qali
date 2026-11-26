#if DEBUG
  import Foundation
  import Observation

  /// `-QaliFixture assistant` (or `-QaliAssistant fixture|empty`): a canned
  /// conversation, and a local stand-in for the model that streams a reply
  /// the way the backend patches its row, so the pane can be looked at and
  /// its animations watched without the network or the monthly allowance.
  /// `-QaliAssistantQuota 2` sets the messages left.
  @Observable
  final class AssistantFixture {
    var threads: [AssistantThread]
    var messages: [AssistantMessage]
    var actions: [AssistantAction]
    var quota: AssistantQuota
    let startsEmpty: Bool

    static func make() -> AssistantFixture? {
      let defaults = UserDefaults.standard
      let mode = defaults.string(forKey: "QaliAssistant")
      guard mode != nil || defaults.string(forKey: "QaliFixture") == "assistant" else { return nil }
      return AssistantFixture(empty: mode == "empty")
    }

    private init(empty: Bool) {
      startsEmpty = empty
      let now = Date.now.timeIntervalSince1970 * 1000
      let hour = 3_600_000.0
      let remaining = UserDefaults.standard.object(forKey: "QaliAssistantQuota") as? Double ?? 7
      quota = AssistantQuota(used: 10 - remaining, limit: 10, remaining: remaining)
      threads = [
        AssistantThread(id: "t1", title: "Lunch with Sam this week", createdAt: now - 20 * hour, lastMessageAt: now - 0.2 * hour),
        AssistantThread(id: "t2", title: "Moving the design review", createdAt: now - 50 * hour, lastMessageAt: now - 49 * hour),
        AssistantThread(id: "t3", title: "Free time next week", createdAt: now - 120 * hour, lastMessageAt: now - 119 * hour),
      ]
      let thursday = Self.nextWeekday(5, hour: 12.5)
      actions = [
        AssistantAction(
          id: "a1", tool: "create_event",
          input: #"{"summary":"Lunch with Sam","guestEmails":["sam.rivera@example.com"],"location":"Tartine, 18th St","time":{"kind":"timed","startMs":\#(thursday),"endMs":\#(thursday + hour)}}"#,
          preview: "Create “Lunch with Sam” on Thursday, 12:30–1:30pm, inviting sam.rivera@example.com",
          operationId: "op1", status: .pending, resultSummary: nil, createdAt: now - 0.2 * hour)
      ]
      messages = [
        AssistantMessage(
          id: "m1", threadId: "t1", role: .user, blocks: [.text("What's on my calendar tomorrow?")], status: .complete,
          createdAt: now - 20 * hour),
        AssistantMessage(
          id: "m2", threadId: "t1", role: .assistant,
          blocks: [
            .toolCall(id: "c1", name: "list_events"), .toolResult(id: "c1", isError: false),
            .text(
              "Tomorrow is fairly light:\n\n- **Standup** at 9:30am\n- **Design critique**, 11am–12pm\n- **Vendor call** at 3pm on Google Meet\n\nYou're free over lunch and after 4pm."
            ),
          ], status: .complete, createdAt: now - 20 * hour + 4000),
        AssistantMessage(
          id: "m3", threadId: "t1", role: .user, blocks: [.text("Thanks!")], status: .complete,
          createdAt: now - 20 * hour + 60_000),
        AssistantMessage(
          id: "m4", threadId: "t1", role: .assistant, blocks: [.text("Any time.")], status: .complete,
          createdAt: now - 20 * hour + 62_000),
        AssistantMessage(
          id: "m5", threadId: "t1", role: .user, blocks: [.text("Can you find time for lunch with Sam on Thursday?")],
          status: .complete, createdAt: now - 0.2 * hour),
        AssistantMessage(
          id: "m6", threadId: "t1", role: .assistant,
          blocks: [
            .toolCall(id: "c2", name: "search_contacts"), .toolResult(id: "c2", isError: false),
            .toolCall(id: "c3", name: "find_free_time"), .toolResult(id: "c3", isError: false),
            .text("Sam Rivera and you are both free on Thursday from noon until 1:30pm."),
            .toolCall(id: "c4", name: "create_event"), .toolResult(id: "c4", isError: false),
            .proposal(toolCallId: "c4", actionId: "a1"),
            .text("I've drafted a lunch for **12:30–1:30pm** at Tartine. It's waiting for you to confirm."),
          ], status: .complete, suggestions: ["Make it 45 minutes instead", "Add a Google Meet link"],
          createdAt: now - 0.2 * hour + 5000),
      ]
      if empty { messages = [] }
    }

    /// The next `weekday` (1 = Sunday) at a wall-clock hour, in ms.
    private static func nextWeekday(_ weekday: Int, hour: Double) -> Double {
      let calendar = Calendar.current
      let start = calendar.nextDate(
        after: .now, matching: DateComponents(weekday: weekday), matchingPolicy: .nextTime) ?? .now
      return calendar.startOfDay(for: start).timeIntervalSince1970 * 1000 + hour * 3_600_000
    }

    /// Plays a turn: the user's row lands, then the reply's row, typing,
    /// one lookup, and prose streamed in a few words at a time.
    func reply(to text: String, data: AssistantData, key: String) async {
      try? await Task.sleep(for: .milliseconds(450))
      let now = Date.now.timeIntervalSince1970 * 1000
      if data.threadId == nil {
        threads.insert(
          AssistantThread(id: "t\(threads.count + 1)", title: text, createdAt: now, lastMessageAt: now), at: 0)
        messages = []
        data.fixtureOpen(threads[0].id)
      }
      let threadId = threads[0].id
      let userId = "m-\(key)"
      let replyId = "r-\(key)"
      messages.append(
        AssistantMessage(id: userId, threadId: threadId, role: .user, blocks: [.text(text)], status: .complete, createdAt: now))
      messages.append(
        AssistantMessage(id: replyId, threadId: threadId, role: .assistant, blocks: [], status: .streaming, createdAt: now + 1))
      data.messagesChanged()
      quota.used += 1
      quota.remaining -= 1

      func update(_ change: (inout AssistantMessage) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == replyId }) else { return }
        change(&messages[index])
      }
      /// Streams `text` into a new text block a few words per patch, as the
      /// backend's flushes arrive.
      func stream(_ text: String) async {
        let words = text.split(separator: " ", omittingEmptySubsequences: false)
        var written = ""
        var started = false
        for (index, word) in words.enumerated() {
          written += (index == 0 ? "" : " ") + word
          guard index % 3 == 2 || index == words.count - 1 else { continue }
          let snapshot = written
          update { message in
            if started {
              message.blocks[message.blocks.count - 1] = .text(snapshot)
            } else {
              message.blocks.append(.text(snapshot))
            }
          }
          started = true
          try? await Task.sleep(for: .milliseconds(160))
        }
      }
      try? await Task.sleep(for: .seconds(0.8))
      await stream("Let me look at Friday for you.")
      update { $0.blocks.append(.toolCall(id: "f1", name: "list_events")) }
      try? await Task.sleep(for: .seconds(1.2))
      update { $0.blocks.append(.toolResult(id: "f1", isError: false)) }
      try? await Task.sleep(for: .seconds(0.3))
      await stream(
        "You have **three things** on Friday:\n\n- **Standup** at 9:30am\n- **Roadmap review** from 11am to noon\n- **Vendor call** at 3pm on Google Meet\n\nThe afternoon after 3:30pm is open, so that's the best window for anything new."
      )
      update {
        $0.status = .complete
        $0.suggestions = ["Block the afternoon for focus", "What about next week?"]
      }
    }

    func decide(_ id: String, confirm: Bool) async {
      guard let index = actions.firstIndex(where: { $0.id == id }) else { return }
      guard confirm else {
        actions[index].status = .rejected
        return
      }
      actions[index].status = .applying
      try? await Task.sleep(for: .seconds(1.2))
      actions[index].status = .applied
      actions[index].resultSummary = "Added “Lunch with Sam” on Thursday at 12:30pm and invited Sam."
    }
  }
#endif
