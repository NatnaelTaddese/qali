import Foundation

// Decodable mirrors of the assistant's Convex rows (packages/backend/convex/
// domains/assistant/tables.ts and validators.ts). Numbers are `Double`, as
// everywhere else the app reads Convex.

/// One conversation (`assistantThreads`).
nonisolated struct AssistantThread: Decodable, Equatable, Identifiable, Sendable {
  var id: String
  var title: String
  var createdAt: Double
  var lastMessageAt: Double

  enum CodingKeys: String, CodingKey {
    case id = "_id"
    case title, createdAt, lastMessageAt
  }
}

/// One piece of a turn, in the order it happened (`assistantBlockValidator`).
nonisolated enum AssistantBlock: Decodable, Equatable, Sendable {
  case text(String)
  case toolCall(id: String, name: String)
  case toolResult(id: String, isError: Bool)
  case proposal(toolCallId: String, actionId: String)
  /// A block type this build doesn't know; skipped when drawing.
  case unknown

  private enum CodingKeys: String, CodingKey {
    case type, text, toolCallId, name, isError, actionId
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    switch try c.decode(String.self, forKey: .type) {
    case "text":
      self = .text(try c.decode(String.self, forKey: .text))
    case "tool_call":
      self = .toolCall(
        id: try c.decode(String.self, forKey: .toolCallId),
        name: try c.decode(String.self, forKey: .name))
    case "tool_result":
      self = .toolResult(
        id: try c.decode(String.self, forKey: .toolCallId),
        isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false)
    case "proposal":
      self = .proposal(
        toolCallId: try c.decode(String.self, forKey: .toolCallId),
        actionId: try c.decode(String.self, forKey: .actionId))
    default:
      self = .unknown
    }
  }
}

/// One turn (`assistantMessages`). The assistant's row is patched in place
/// while the model streams, so a subscription re-delivers it as it grows.
nonisolated struct AssistantMessage: Decodable, Equatable, Identifiable, Sendable {
  enum Role: String, Decodable, Sendable { case user, assistant }
  enum Status: String, Decodable, Sendable { case streaming, complete, error }

  var id: String
  var threadId: String
  var role: Role
  var blocks: [AssistantBlock]
  var status: Status
  var error: String?
  /// Suggested next prompts, set best-effort once a turn settles.
  var suggestions: [String]?
  var createdAt: Double

  enum CodingKeys: String, CodingKey {
    case id = "_id"
    case threadId, role, blocks, status, error, suggestions, createdAt
  }

  /// Everything the turn said, joined: a user turn's own words.
  var text: String {
    blocks.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined()
  }
}

/// A write the assistant wants to make, held until the user confirms it
/// (`assistantActions`).
nonisolated struct AssistantAction: Decodable, Equatable, Identifiable, Sendable {
  enum Status: String, Decodable, Sendable { case pending, applying, applied, rejected, failed }

  var id: String
  var tool: String
  /// The model's argument JSON, as stored.
  var input: String
  /// A one-line description of the change, written by the server.
  var preview: String
  /// Google's client-chosen event id for a create.
  var operationId: String?
  var status: Status
  var resultSummary: String?
  var createdAt: Double

  enum CodingKeys: String, CodingKey {
    case id = "_id"
    case tool, input, preview, operationId, status, resultSummary, createdAt
  }

  /// The decoded tool arguments, when they are a JSON object.
  var arguments: [String: Any] {
    guard let data = input.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [:] }
    return object
  }

  /// The Convex event id an update, move or delete acts on.
  var eventId: String? { arguments["eventId"] as? String }

  /// The start of a timed `time` argument, for revealing the change on the
  /// grid once it lands.
  var timedStartMs: Double? {
    guard let time = arguments["time"] as? [String: Any], time["kind"] as? String == "timed" else { return nil }
    return (time["startMs"] as? NSNumber)?.doubleValue
  }

  /// What the confirm button approves beyond the one-line preview: every
  /// guest address (Google emails each one), and the description and
  /// location in full, so nothing slipped into them rides through unseen.
  var details: [(label: String, value: String)] {
    let args = arguments
    var rows: [(String, String)] = []
    if let guests = args["guestEmails"] as? [Any] {
      let emails = guests.compactMap { $0 as? String }
      if !emails.isEmpty { rows.append(("Guests (\(emails.count))", emails.joined(separator: "\n"))) }
    }
    if let description = args["description"] as? String, !description.isEmpty {
      rows.append(("Description", description))
    }
    if let location = args["location"] as? String, !location.isEmpty {
      rows.append(("Location", location))
    }
    return rows
  }
}

/// The rolling-30-day message allowance (`monthlyQuota`).
nonisolated struct AssistantQuota: Decodable, Equatable, Sendable {
  var used: Double
  var limit: Double
  var remaining: Double
}

nonisolated struct AssistantSendResult: Decodable, Sendable {
  var threadId: String
}
