// The pure logic behind the agent loop: reassembling streamed tool calls,
// rebuilding wire history from stored turns, and subtracting busy time from a
// window.
//
// A leaf module like ./permissions.ts and ./availability.ts — it imports
// nothing, so all three can be exercised directly under `bun test`. That
// matters more here than elsewhere: these are the parts of the assistant whose
// bugs are silent. A tool-call accumulator that drops a parallel call, or a
// history rebuild that emits a tool result with no matching call, does not
// throw — it just quietly makes the model behave worse.

/** One fragment of a streamed tool call, as OpenAI-format deltas deliver them. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** A tool call being reassembled across many deltas. */
export interface PendingCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Fold one chunk's tool-call deltas into the accumulator.
 *
 * Tool calls do not arrive whole. The id and name land once, and the arguments
 * dribble in as string fragments that are only valid JSON after concatenation —
 * so nothing here may parse mid-stream. Everything is keyed by `index`, which
 * is the only thing tying a fragment to the call it belongs to: reading
 * `tool_calls[0]` instead, the obvious shape, silently drops every parallel
 * call after the first.
 */
export function applyToolCallDeltas(
  calls: Map<number, PendingCall>,
  deltas: ToolCallDelta[] | undefined,
): void {
  for (const delta of deltas ?? []) {
    const slot = calls.get(delta.index) ?? { id: "", name: "", args: "" };
    if (delta.id) slot.id = delta.id;
    if (delta.function?.name) slot.name = delta.function.name;
    if (delta.function?.arguments) slot.args += delta.function.arguments;
    calls.set(delta.index, slot);
  }
}

/** The accumulated calls in the order the model emitted them. */
export function orderedCalls(calls: Map<number, PendingCall>): PendingCall[] {
  return [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call);
}

// --- History ---------------------------------------------------------------

/** The stored shape of one piece of a turn. Structural on purpose: this module
 * must not reach for the generated data model. */
export type StoredBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCallId: string; name: string; arguments: string }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean }
  | { type: "proposal"; toolCallId: string; actionId: string };

export interface StoredTurn {
  role: "user" | "assistant";
  blocks: StoredBlock[];
}

/** The subset of a chat message this module produces. Assignable to the
 * OpenAI SDK's parameter types without importing them. */
export type WireMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Rebuild the wire history from stored turns.
 *
 * Two invariants the API enforces and this has to honour. Every tool result
 * must follow the assistant message that requested it, as its own `role: "tool"`
 * entry — so one stored turn that interleaves prose, calls and results splits
 * into several wire messages. And a tool result must never appear without its
 * call, which is why the assistant message is flushed before the first result
 * rather than after the last block.
 *
 * `resultOverrides`, keyed by tool-call id, replaces what a tool said at the
 * time with what became of it. That is how a write tool's "awaiting your
 * confirmation" is replaced by "the user confirmed this" on later turns —
 * without it the model reads its own stale reply and asks again.
 */
export function toWireMessages(
  turns: StoredTurn[],
  resultOverrides: Map<string, string> = new Map(),
): WireMessage[] {
  const out: WireMessage[] = [];

  for (const turn of turns) {
    if (turn.role === "user") {
      out.push({
        role: "user",
        content: turn.blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(""),
      });
      continue;
    }

    let content = "";
    let toolCalls: {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }[] = [];

    const flushAssistant = () => {
      if (!content && toolCalls.length === 0) return;
      out.push({
        role: "assistant",
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      content = "";
      toolCalls = [];
    };

    for (const block of turn.blocks) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_call") {
        toolCalls.push({
          id: block.toolCallId,
          type: "function",
          function: { name: block.name, arguments: block.arguments },
        });
      } else if (block.type === "tool_result") {
        // Text and calls have to land before the results they produced.
        flushAssistant();
        out.push({
          role: "tool",
          tool_call_id: block.toolCallId,
          content: resultOverrides.get(block.toolCallId) ?? block.content,
        });
      }
      // `proposal` blocks drive the confirm card; the model has no use for them.
    }
    flushAssistant();
  }

  return out;
}

// --- Free time -------------------------------------------------------------

/** A half-open span of absolute time, `[startMs, endMs)`. */
export interface Span {
  startMs: number;
  endMs: number;
}

/**
 * The parts of `window` that `busy` does not cover.
 *
 * `busy` must already be sorted and merged — overlapping input would let the
 * cursor walk backwards and emit a span that is actually occupied.
 */
export function subtractBusy(window: Span, busy: Span[]): Span[] {
  const free: Span[] = [];
  let cursor = window.startMs;
  for (const b of busy) {
    if (b.endMs <= cursor) continue;
    if (b.startMs >= window.endMs) break;
    if (b.startMs > cursor) {
      free.push({ startMs: cursor, endMs: Math.min(b.startMs, window.endMs) });
    }
    cursor = Math.max(cursor, b.endMs);
    if (cursor >= window.endMs) break;
  }
  if (cursor < window.endMs) {
    free.push({ startMs: cursor, endMs: window.endMs });
  }
  return free;
}
