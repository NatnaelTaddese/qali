// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
  acknowledgedAssistantUserMessageId,
  isNearScrollBottom,
  safeAssistantLink,
  shouldOpenAssistantShortcut,
  shouldSendAssistantMessage,
} from "./assistant-interactions";

describe("assistant interactions", () => {
  test("follows scrolling only near the bottom", () => {
    expect(
      isNearScrollBottom({ scrollHeight: 500, scrollTop: 260, clientHeight: 200 }),
    ).toBe(true);
    expect(
      isNearScrollBottom({ scrollHeight: 500, scrollTop: 200, clientHeight: 200 }),
    ).toBe(false);
  });

  test("does not send Enter while composing or adding a newline", () => {
    expect(
      shouldSendAssistantMessage({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
      }),
    ).toBe(true);
    expect(
      shouldSendAssistantMessage({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
      }),
    ).toBe(false);
    expect(
      shouldSendAssistantMessage({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
      }),
    ).toBe(false);
  });

  test("respects consumed, editable, and blocked assistant shortcuts", () => {
    const event = {
      key: "k",
      metaKey: true,
      ctrlKey: false,
      defaultPrevented: false,
    };
    expect(
      shouldOpenAssistantShortcut(event, {
        blocked: false,
        editableTarget: false,
      }),
    ).toBe(true);
    expect(
      shouldOpenAssistantShortcut(
        { ...event, defaultPrevented: true },
        { blocked: false, editableTarget: false },
      ),
    ).toBe(false);
    expect(
      shouldOpenAssistantShortcut(event, {
        blocked: false,
        editableTarget: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenAssistantShortcut(event, {
        blocked: true,
        editableTarget: false,
      }),
    ).toBe(false);
  });

  test("allows only absolute HTTP links", () => {
    expect(safeAssistantLink("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(safeAssistantLink("javascript:alert(1)")).toBeNull();
    expect(safeAssistantLink("data:text/html,unsafe")).toBeNull();
    expect(safeAssistantLink("/internal")).toBeNull();
  });

  test("acknowledges only the newly appended matching user message", () => {
    const previous = {
      _id: "old",
      role: "user",
      blocks: [{ type: "text", text: "Same prompt" }],
    };
    expect(
      acknowledgedAssistantUserMessageId([previous], "old", "Same prompt"),
    ).toBeNull();
    expect(
      acknowledgedAssistantUserMessageId(
        [
          previous,
          {
            _id: "new",
            role: "user",
            blocks: [{ type: "text", text: "Same prompt" }],
          },
        ],
        "old",
        "Same prompt",
      ),
    ).toBe("new");
  });
});
