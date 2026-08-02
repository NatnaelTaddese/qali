// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { completeMarkdown } from "./streaming-markdown";

describe("completeMarkdown", () => {
  test("leaves finished markdown untouched", () => {
    const done = "You have **three** meetings.\n\n- One\n- Two";
    expect(completeMarkdown(done)).toBe(done);
  });

  test("leaves plain prose untouched", () => {
    expect(completeMarkdown("Your Friday is clear.")).toBe(
      "Your Friday is clear.",
    );
  });

  test("closes bold caught mid-word", () => {
    expect(completeMarkdown("You have **three")).toBe("You have **three**");
  });

  test("does not close bold that is already balanced", () => {
    expect(completeMarkdown("**a** and **b**")).toBe("**a** and **b**");
  });

  test("closes an unterminated inline code span", () => {
    expect(completeMarkdown("Run `bun test")).toBe("Run `bun test`");
  });

  test("closes an unterminated fence on its own line", () => {
    expect(completeMarkdown("```ts\nconst a = 1;")).toBe(
      "```ts\nconst a = 1;\n```",
    );
  });

  test("does not add a blank line when the fence body already ends in one", () => {
    expect(completeMarkdown("```\ncode\n")).toBe("```\ncode\n```");
  });

  test("a closed fence needs no repair", () => {
    const done = "```\ncode\n```";
    expect(completeMarkdown(done)).toBe(done);
  });

  test("ignores markers inside a closed code fence", () => {
    // The asterisks are code, not emphasis — closing them would corrupt it.
    const done = "```\na ** b\n```";
    expect(completeMarkdown(done)).toBe(done);
  });

  test("ignores markers inside inline code", () => {
    const done = "Use `a ** b` carefully.";
    expect(completeMarkdown(done)).toBe(done);
  });

  test("an open fence swallows bold rather than closing it", () => {
    // Inside a fence the asterisks are literal, so only the fence is repaired.
    expect(completeMarkdown("```\n**not bold")).toBe("```\n**not bold\n```");
  });

  test("closes strikethrough", () => {
    expect(completeMarkdown("~~cancelled")).toBe("~~cancelled~~");
  });

  test("leaves a lone asterisk alone", () => {
    // Single-character emphasis is deliberately not repaired: `2 * 3` and
    // snake_case are far more common in prose than a half-typed italic.
    expect(completeMarkdown("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(completeMarkdown("call get_event_by")).toBe("call get_event_by");
  });

  test("handles empty input", () => {
    expect(completeMarkdown("")).toBe("");
  });

  test("every prefix of a streamed reply stays parseable", () => {
    // The real invariant: the panel renders each prefix in turn, so none of
    // them may leave a construct open.
    const full = "You have **two** meetings. Run `sync` first.";
    for (let i = 1; i <= full.length; i += 1) {
      const repaired = completeMarkdown(full.slice(0, i));
      const fences = (repaired.match(/```/g) ?? []).length;
      const ticks = (repaired.match(/`/g) ?? []).length - fences * 3;
      expect(fences % 2).toBe(0);
      expect(ticks % 2).toBe(0);
    }
  });
});
