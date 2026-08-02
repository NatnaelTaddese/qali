// @ts-expect-error Bun supplies its test module at runtime; the Convex
// TypeScript project intentionally does not include Bun's ambient types.
import { describe, expect, test } from "bun:test";

import {
  applyToolCallDeltas,
  orderedCalls,
  type PendingCall,
  type StoredTurn,
  subtractBusy,
  toWireMessages,
} from "./assistantHistory";

describe("applyToolCallDeltas", () => {
  test("concatenates argument fragments into valid JSON", () => {
    const calls = new Map<number, PendingCall>();
    applyToolCallDeltas(calls, [
      { index: 0, id: "call_1", function: { name: "list_events" } },
    ]);
    applyToolCallDeltas(calls, [{ index: 0, function: { arguments: '{"fro' } }]);
    applyToolCallDeltas(calls, [{ index: 0, function: { arguments: 'mMs":1,' } }]);
    applyToolCallDeltas(calls, [{ index: 0, function: { arguments: '"toMs":2}' } }]);

    const [call] = orderedCalls(calls);
    expect(call.id).toBe("call_1");
    expect(call.name).toBe("list_events");
    expect(JSON.parse(call.args)).toEqual({ fromMs: 1, toMs: 2 });
  });

  test("keeps parallel calls apart and in emission order", () => {
    const calls = new Map<number, PendingCall>();
    // Both calls interleave across chunks, which is what the wire actually does.
    applyToolCallDeltas(calls, [
      { index: 0, id: "a", function: { name: "list_events", arguments: "{}" } },
      { index: 1, id: "b", function: { name: "search_contacts" } },
    ]);
    applyToolCallDeltas(calls, [
      { index: 1, function: { arguments: '{"query":"sam"}' } },
    ]);

    const ordered = orderedCalls(calls);
    expect(ordered).toHaveLength(2);
    expect(ordered.map((c) => c.name)).toEqual([
      "list_events",
      "search_contacts",
    ]);
    expect(JSON.parse(ordered[1].args)).toEqual({ query: "sam" });
  });

  test("orders by index, not by arrival", () => {
    const calls = new Map<number, PendingCall>();
    applyToolCallDeltas(calls, [{ index: 2, id: "c", function: { name: "c" } }]);
    applyToolCallDeltas(calls, [{ index: 0, id: "a", function: { name: "a" } }]);
    applyToolCallDeltas(calls, [{ index: 1, id: "b", function: { name: "b" } }]);
    expect(orderedCalls(calls).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("tolerates a chunk with no tool calls", () => {
    const calls = new Map<number, PendingCall>();
    applyToolCallDeltas(calls, undefined);
    applyToolCallDeltas(calls, []);
    expect(orderedCalls(calls)).toEqual([]);
  });
});

describe("toWireMessages", () => {
  test("splits a tool-using turn so results follow their call", () => {
    const turns: StoredTurn[] = [
      { role: "user", blocks: [{ type: "text", text: "what's on today?" }] },
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "Let me look." },
          {
            type: "tool_call",
            toolCallId: "call_1",
            name: "list_events",
            arguments: "{}",
          },
          { type: "tool_result", toolCallId: "call_1", content: "[]" },
          { type: "text", text: "Nothing today." },
        ],
      },
    ];

    expect(toWireMessages(turns)).toEqual([
      { role: "user", content: "what's on today?" },
      {
        role: "assistant",
        content: "Let me look.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_events", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "[]" },
      { role: "assistant", content: "Nothing today." },
    ]);
  });

  test("emits one assistant message carrying both parallel calls", () => {
    const turns: StoredTurn[] = [
      {
        role: "assistant",
        blocks: [
          { type: "tool_call", toolCallId: "a", name: "list_events", arguments: "{}" },
          { type: "tool_call", toolCallId: "b", name: "search_contacts", arguments: "{}" },
          { type: "tool_result", toolCallId: "a", content: "[]" },
          { type: "tool_result", toolCallId: "b", content: "[]" },
        ],
      },
    ];

    const wire = toWireMessages(turns);
    expect(wire).toHaveLength(3);
    const assistant = wire[0] as Extract<
      (typeof wire)[number],
      { role: "assistant" }
    >;
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toHaveLength(2);
    expect(wire[1]).toEqual({ role: "tool", tool_call_id: "a", content: "[]" });
    expect(wire[2]).toEqual({ role: "tool", tool_call_id: "b", content: "[]" });
  });

  test("never emits a tool result before its call", () => {
    const turns: StoredTurn[] = [
      {
        role: "assistant",
        blocks: [
          { type: "tool_call", toolCallId: "a", name: "x", arguments: "{}" },
          { type: "tool_result", toolCallId: "a", content: "ok" },
          { type: "tool_call", toolCallId: "b", name: "y", arguments: "{}" },
          { type: "tool_result", toolCallId: "b", content: "ok" },
        ],
      },
    ];

    const wire = toWireMessages(turns);
    const seenCalls = new Set<string>();
    for (const message of wire) {
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) seenCalls.add(call.id);
      }
      if (message.role === "tool") {
        expect(seenCalls.has(message.tool_call_id)).toBe(true);
      }
    }
  });

  test("proposal blocks are dropped — they are for the panel only", () => {
    const turns: StoredTurn[] = [
      {
        role: "assistant",
        blocks: [
          { type: "tool_call", toolCallId: "a", name: "create_event", arguments: "{}" },
          { type: "tool_result", toolCallId: "a", content: "Proposed." },
          { type: "proposal", toolCallId: "a", actionId: "act_1" },
        ],
      },
    ];
    expect(toWireMessages(turns).some((m) => "actionId" in m)).toBe(false);
    expect(toWireMessages(turns)).toHaveLength(2);
  });

  test("an override replaces what the tool said at the time", () => {
    const turns: StoredTurn[] = [
      {
        role: "assistant",
        blocks: [
          { type: "tool_call", toolCallId: "a", name: "create_event", arguments: "{}" },
          {
            type: "tool_result",
            toolCallId: "a",
            content: "Proposed. Awaiting confirmation.",
          },
        ],
      },
    ];
    const wire = toWireMessages(
      turns,
      new Map([["a", "The user confirmed this. Created “Lunch”."]]),
    );
    expect(wire[1]).toEqual({
      role: "tool",
      tool_call_id: "a",
      content: "The user confirmed this. Created “Lunch”.",
    });
  });
});

describe("subtractBusy", () => {
  const window = { startMs: 0, endMs: 100 };

  test("returns the whole window when nothing is busy", () => {
    expect(subtractBusy(window, [])).toEqual([window]);
  });

  test("splits around a busy span in the middle", () => {
    expect(subtractBusy(window, [{ startMs: 40, endMs: 60 }])).toEqual([
      { startMs: 0, endMs: 40 },
      { startMs: 60, endMs: 100 },
    ]);
  });

  test("clips busy spans that overhang either edge", () => {
    expect(
      subtractBusy(window, [
        { startMs: -50, endMs: 20 },
        { startMs: 80, endMs: 200 },
      ]),
    ).toEqual([{ startMs: 20, endMs: 80 }]);
  });

  test("returns nothing when the window is fully covered", () => {
    expect(subtractBusy(window, [{ startMs: -10, endMs: 110 }])).toEqual([]);
  });

  test("ignores busy spans entirely outside the window", () => {
    expect(
      subtractBusy(window, [
        { startMs: -30, endMs: -10 },
        { startMs: 200, endMs: 300 },
      ]),
    ).toEqual([window]);
  });

  test("a back-to-back pair leaves no phantom gap between them", () => {
    expect(
      subtractBusy(window, [
        { startMs: 20, endMs: 40 },
        { startMs: 40, endMs: 60 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 20 },
      { startMs: 60, endMs: 100 },
    ]);
  });
});
